/**
 * CampaignContentToolsCards — the two derive-from-the-body tools.
 *
 * CONTENT OPTIMIZER (desktop ContentOptimizerCard): the latest persisted run
 * (GET, viewer; 404 = none) and the on-demand bandit allocation preview
 * (POST …/preview, editor). The PERSISTED run is deliberately not offered —
 * desktop disables it because dispatch does not consume runs yet, and a
 * control that looks active while changing nothing at send time is a phantom
 * (lib/campaignOptimizer).
 *
 * CONTENT REMIX (desktop ContentRemixCard): POST /campaigns/{id}/remix
 * derives web-teaser / SMS / social / podcast assets from the body,
 * synchronously; each asset gets a copy button, because sharing is the one
 * job a phone does best.
 *
 * Both are editor verbs — the caller renders these only for canMutate
 * sessions.
 */
import * as Clipboard from "expo-clipboard";
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import {
  ActionButton,
  Card,
} from "@/components/campaigns/CampaignDetailControls";
import {
  useCampaignOptimizerPreview,
  useCampaignOptimizerRun,
  useCampaignRemixRun,
} from "@/hooks/useCampaignMeasure";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import type { OptimizerPreviewReading } from "@/lib/campaignOptimizer";
import type { RemixAssetRow } from "@/lib/campaignRemix";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function CardTitle({ label, t }: { label: string; t: ThemeTokens }) {
  return (
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
      {label}
    </Text>
  );
}

function ArmList({
  preview,
  t,
}: {
  preview: OptimizerPreviewReading;
  t: ThemeTokens;
}) {
  return (
    <View style={{ gap: 8, marginTop: 10 }}>
      {preview.arms.map((arm) => (
        <View key={arm.key} style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <Pill label={`${Math.round(arm.allocationPercent)}%`} />
            <Text
              {...typeCap("bodySmall")}
              numberOfLines={1}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.medium,
                flexShrink: 1,
              }}
            >
              {arm.subject || arm.key}
            </Text>
          </View>
          {arm.reason ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {arm.reason}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

export function CampaignOptimizerCard({ campaignId }: { campaignId: string }) {
  const { t } = useTheme();
  const { toast } = useToast();
  const run = useCampaignOptimizerRun(campaignId, { enabled: true });
  const preview = useCampaignOptimizerPreview(campaignId);

  const onPreview = () => {
    if (preview.isPending) return;
    haptics.tap();
    preview.mutate(undefined, {
      onError: (err: unknown) =>
        toast({
          kind: "error",
          message: campaignErrorMessage(
            err,
            "Couldn't compute an allocation preview.",
          ),
        }),
    });
  };

  const shown = preview.data ?? run.data?.preview ?? null;

  return (
    <Card>
      <CardTitle label="Content optimizer" t={t} />
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginBottom: 10,
        }}
      >
        {run.data
          ? `Latest run: ${run.data.status || "recorded"}. Preview below computes a fresh allocation; nothing is persisted.`
          : "How a bandit would split traffic across this campaign's variants. Nothing is persisted — dispatch does not consume optimizer runs yet."}
      </Text>
      <View style={{ flexDirection: "row" }}>
        <ActionButton
          label={preview.isPending ? "Computing…" : "Preview allocation"}
          onPress={onPreview}
          disabled={preview.isPending}
        />
      </View>
      {shown ? (
        <>
          {shown.method || shown.primaryMetric ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 8,
              }}
            >
              {[shown.method, shown.primaryMetric].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
          <ArmList preview={shown} t={t} />
        </>
      ) : null}
    </Card>
  );
}

function RemixAsset({
  asset,
  t,
  onCopy,
}: {
  asset: RemixAssetRow;
  t: ThemeTokens;
  onCopy: (asset: RemixAssetRow) => void;
}) {
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
        gap: 6,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Pill label={asset.label} />
        <ActionButton label="Copy" onPress={() => onCopy(asset)} />
      </View>
      {asset.title ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
        >
          {asset.title}
        </Text>
      ) : null}
      <Text
        {...typeCap("bodySmall")}
        numberOfLines={6}
        selectable
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {asset.body}
      </Text>
    </View>
  );
}

export function CampaignRemixCard({ campaignId }: { campaignId: string }) {
  const { t } = useTheme();
  const { toast } = useToast();
  const remix = useCampaignRemixRun(campaignId);

  const onRun = () => {
    if (remix.isPending) return;
    haptics.tap();
    remix.mutate(undefined, {
      onSuccess: (assets) => {
        if (assets.length === 0) {
          toast({
            kind: "warning",
            message:
              "The remix came back empty — the campaign body may have nothing to derive from yet.",
          });
        }
      },
      onError: (err: unknown) =>
        toast({
          kind: "error",
          message: campaignErrorMessage(err, "Couldn't remix the content."),
        }),
    });
  };

  const onCopy = (asset: RemixAssetRow) => {
    void Clipboard.setStringAsync(
      asset.title ? `${asset.title}\n\n${asset.body}` : asset.body,
    ).then(() =>
      toast({ kind: "success", message: `${asset.label} copied.` }),
    );
  };

  return (
    <Card>
      <CardTitle label="Content remix" t={t} />
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginBottom: 10,
        }}
      >
        Copy-paste-ready web teaser, SMS, social and podcast versions derived
        from this campaign&apos;s body.
      </Text>
      <View style={{ flexDirection: "row" }}>
        <ActionButton
          label={remix.isPending ? "Deriving…" : "Derive channel versions"}
          onPress={onRun}
          disabled={remix.isPending}
        />
      </View>
      {remix.data && remix.data.length > 0 ? (
        <View style={{ gap: 10, marginTop: 10 }}>
          {remix.data.map((asset) => (
            <RemixAsset key={asset.key} asset={asset} t={t} onCopy={onCopy} />
          ))}
        </View>
      ) : null}
    </Card>
  );
}
