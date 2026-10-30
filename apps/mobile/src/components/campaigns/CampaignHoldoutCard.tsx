/**
 * CampaignHoldoutCard — configure the measurement BEFORE the send.
 *
 * Mobile read the lift (Insights → "Incremental lift") and its empty state
 * literally said "Set one up on the web app". This is the setup half:
 * POST/DELETE /api/v1/campaigns/{id}/holdout, per desktop's HoldoutCard.
 *
 * ADMIN-GATED BY THE CALLER: the handler binds ScopeAdmin (holdout.go:103-106),
 * so on the session path only owner/admin can write. The card is simply not
 * rendered for anyone else — an editor is never offered a button that can
 * only 403 (see lib/campaignHoldout's role note).
 *
 * ONLINE-ONLY: the write partitions a future send's audience for measurement;
 * replaying a stale queued config would silently change what an experiment
 * measures.
 */
import { Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import {
  ActionButton,
  Card,
} from "@/components/campaigns/CampaignDetailControls";
import {
  useCampaignHoldout,
  useCampaignHoldoutWrite,
} from "@/hooks/useCampaignMeasure";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import {
  HOLDOUT_PERCENT_OPTIONS,
  holdoutSummary,
} from "@/lib/campaignHoldout";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignHoldoutCard({ campaignId }: { campaignId: string }) {
  const { t } = useTheme();
  const { toast } = useToast();
  const reading = useCampaignHoldout(campaignId, { enabled: true });
  const write = useCampaignHoldoutWrite(campaignId);
  const holdout = reading.data ?? null;
  const busy = write.isPending || reading.isLoading;

  const act = (
    action: { kind: "create"; percent: number } | { kind: "remove" },
    success: string,
  ) => {
    if (busy) return;
    haptics.tap();
    write.mutate(action, {
      onSuccess: () => toast({ kind: "success", message: success }),
      onError: (err: unknown) =>
        toast({
          kind: "error",
          message: campaignErrorMessage(
            err,
            "Couldn't change the holdout configuration.",
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
          marginBottom: 4,
        }}
      >
        Incremental-lift holdout
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          marginBottom: 10,
        }}
      >
        {holdoutSummary(holdout)}
      </Text>
      {holdout && !holdout.decided ? (
        <View style={{ flexDirection: "row" }}>
          <ActionButton
            label={write.isPending ? "Removing…" : "Remove holdout"}
            danger
            onPress={() =>
              act(
                { kind: "remove" },
                "Holdout removed — everyone receives the send.",
              )
            }
            disabled={busy}
          />
        </View>
      ) : holdout?.decided ? null : (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {HOLDOUT_PERCENT_OPTIONS.map((percent) => (
            <ActionButton
              key={percent}
              label={`Hold out ${percent}%`}
              onPress={() =>
                act(
                  { kind: "create", percent },
                  `A ${percent}% holdout will be applied at send time.`,
                )
              }
              disabled={busy}
            />
          ))}
        </View>
      )}
    </Card>
  );
}
