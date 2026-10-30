/**
 * SubjectLabBanditRow — the lab → bandit handoff (desktop parity:
 * useCampaignCreation.ts runBandit, offered from SubjectLab's scored list).
 *
 * Renders ONLY when the screen arrived from a campaign (the `?campaignId`
 * deep link) AND the scoring panel has a ranked reading with 2+ distinct
 * candidates. The test is created against that campaign's own audience and
 * body via the same hand-off hook the subject sheet uses, with
 * `delivery_settings.ab_test.bandit` armed (lib/campaignAbVariants); the
 * campaign's missing-audience refusal renders as a sentence, not a 400.
 *
 * Creating the test is press-driven and online-only by construction — the
 * hand-off hook is not in the offline mutation contract, which is right for a
 * verb that creates real campaign rows.
 *
 * NativeWind v4 house rule: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { useCampaign, type CampaignDetail } from "@/hooks/useCampaigns";
import { useCampaignAbHandoff } from "@/hooks/useCampaignAbHandoff";
import { FONT } from "@/lib/fonts";
import type { SubjectScoreRow } from "@/lib/subjectLab";
import { banditRowCaption, banditVariantsFrom } from "@/lib/subjectLabBandit";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubjectLabBanditRow({
  campaignId,
  rows,
}: {
  campaignId: string;
  rows: readonly SubjectScoreRow[];
}) {
  const campaign = useCampaign(campaignId);
  const variants = banditVariantsFrom(rows);
  // No reading worth a test: offer nothing rather than a one-arm bandit.
  if (!variants) return null;
  // The campaign read failed: say so rather than silently withholding the verb
  // the person crossed tabs for. (Still loading renders nothing — it is the
  // detail query the campaign screen just made, so it resolves from cache.)
  if (campaign.isError) {
    return (
      <BanditNotice text="Couldn't load the campaign this lab was opened from, so its subjects can't be run as a bandit from here. Go back to the campaign and try again." />
    );
  }
  if (!campaign.data) return null;
  return <BanditInner campaign={campaign.data} variants={variants} />;
}

/** The warning-toned sentence for the two reasons the row cannot offer a tap. */
function BanditNotice({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.warning,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginTop: 4,
      }}
    >
      {text}
    </Text>
  );
}

function BanditInner({
  campaign,
  variants,
}: {
  campaign: CampaignDetail;
  variants: string[];
}) {
  const { t } = useTheme();
  const handoff = useCampaignAbHandoff({
    campaign,
    // The hand-off pushes to the new parent's detail screen itself; there is
    // no sheet to close here.
    onDone: () => {},
  });

  if (handoff.blockedReason) {
    return <BanditNotice text={handoff.blockedReason} />;
  }

  const label = handoff.pending
    ? "Creating bandit test…"
    : `Run top ${variants.length} as a bandit`;
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      <Pressable
        onPress={() => handoff.run(variants, null, { bandit: true })}
        disabled={handoff.pending}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={banditRowCaption(variants.length)}
        accessibilityState={{ disabled: handoff.pending, busy: handoff.pending }}
        style={{
          minHeight: 48,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 16,
          backgroundColor: handoff.pending ? t.bgSubtle : t.accent,
          borderWidth: 1,
          borderColor: handoff.pending ? t.border : t.accent,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: handoff.pending ? t.fgSubtle : t.accentFg,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {label}
        </Text>
      </Pressable>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {banditRowCaption(variants.length)}
      </Text>
    </View>
  );
}
