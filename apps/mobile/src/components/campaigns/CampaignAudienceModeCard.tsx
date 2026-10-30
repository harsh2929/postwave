/**
 * CampaignAudienceModeCard — dynamic vs static audience, and "freeze now".
 *
 * Desktop's editor offers both (CampaignDetailEditor.tsx:126-165); mobile
 * could only ever read the audience. Two verbs land here:
 *
 *   - the audience_mode flip (PATCH /campaigns/{id}, pointer field);
 *   - POST /campaigns/{id}/audience/freeze — snapshot TODAY's membership and
 *     stamp the mode static, answering {frozen_members}.
 *
 * Both are ONLINE-ONLY (lib/campaignAudienceMode says why: the freeze is a
 * time-anchored act, and a replayed flip usually precedes one). Both are
 * editor verbs, so the whole card renders only for canMutate sessions on an
 * editable campaign — an affordance a role cannot use is omitted, not shown
 * disabled.
 *
 * The 422s are product rules, not failures: a workspace-wide campaign has no
 * membership to freeze, and freezeErrorMessage renders that rule in words.
 */
import { Text, View } from "react-native";

import { SegmentedControl } from "@/components/SegmentedControl";
import { useToast } from "@/components/Toast";
import {
  ActionButton,
  Card,
} from "@/components/campaigns/CampaignDetailControls";
import {
  useCampaignAudienceFreeze,
  useCampaignAuthoringPatch,
} from "@/hooks/useCampaignAuthoring";
import {
  AUDIENCE_MODE_OPTIONS,
  audienceModeHelp,
  campaignAudienceMode,
  freezeErrorMessage,
  type CampaignAudienceMode,
} from "@/lib/campaignAudienceMode";
import { campaignErrorCode, campaignErrorMessage } from "@/lib/campaignErrors";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignAudienceModeCard({
  campaign,
}: {
  campaign: { id: string; audience_mode?: unknown };
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const mode = campaignAudienceMode(campaign);
  const patch = useCampaignAuthoringPatch(campaign.id);
  const freeze = useCampaignAudienceFreeze(campaign.id);
  const busy = patch.isPending || freeze.isPending;

  const onMode = (next: CampaignAudienceMode) => {
    if (busy || next === mode) return;
    haptics.tap();
    patch.mutate(
      { audience_mode: next },
      {
        onSuccess: () =>
          toast({
            kind: "success",
            message:
              next === "static"
                ? "Audience set to static — freeze a snapshot below to pin today's membership."
                : "Audience set to dynamic — membership re-evaluates at send time.",
          }),
        onError: (err: unknown) =>
          toast({
            kind: "error",
            message: campaignErrorMessage(
              err,
              "Couldn't change the audience mode.",
            ),
          }),
      },
    );
  };

  const onFreeze = () => {
    if (busy) return;
    haptics.impact();
    freeze.mutate(undefined, {
      onSuccess: ({ frozenMembers }) =>
        toast({
          kind: "success",
          message: `Froze today's membership — ${plural(
            frozenMembers,
            "member",
          )} pinned for this send.`,
        }),
      onError: (err: unknown) =>
        toast({
          kind: "error",
          message: freezeErrorMessage(
            campaignErrorCode(err),
            campaignErrorMessage(err, "Couldn't freeze the audience."),
          ),
        }),
    });
  };

  return (
    <Card>
      <Text
        {...typeCap("callout")}
        accessibilityRole="header"
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
          marginBottom: 8,
        }}
      >
        Audience mode
      </Text>
      <SegmentedControl<CampaignAudienceMode>
        options={AUDIENCE_MODE_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
        }))}
        value={mode}
        onChange={onMode}
        accessibilityLabel="Audience mode"
      />
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 8,
        }}
      >
        {audienceModeHelp(mode)}
      </Text>
      <View style={{ flexDirection: "row", marginTop: 12 }}>
        <ActionButton
          label={freeze.isPending ? "Freezing…" : "Freeze audience now"}
          onPress={onFreeze}
          disabled={busy}
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 6,
        }}
      >
        Freezing snapshots the segment&apos;s membership as it stands right now
        and sets the mode to static.
      </Text>
    </Card>
  );
}
