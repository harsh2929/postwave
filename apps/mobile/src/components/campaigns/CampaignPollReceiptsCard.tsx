/** F14 viewer surface: observed poll outcomes and their immutable provenance. */
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import { ReceiptValue } from "@/components/campaigns/CampaignAssurancePrimitives";
import { useCampaignPollReceipts } from "@/hooks/useCampaignPollReceipts";
import type { CampaignPollReceipt } from "@/lib/campaignPolls";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignPollReceiptsCard({
  campaignId,
  hasSemanticPoll,
}: {
  campaignId: string;
  hasSemanticPoll: boolean;
}) {
  const { t } = useTheme();
  const query = useCampaignPollReceipts(campaignId);
  const receipts = Array.isArray(query.data) ? query.data : [];
  if (
    !query.isLoading &&
    !query.isError &&
    receipts.length === 0 &&
    !hasSemanticPoll
  ) {
    return null;
  }

  return (
    <Card
      accessibilityLabel="Campaign poll confirmation receipts"
      style={{ marginTop: 12, gap: 10 }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text
            {...typeCap("body")}
            accessibilityRole="header"
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
            }}
          >
            Poll confirmation receipts
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginTop: 2,
            }}
          >
            Confirmed outcomes bound to an exact immutable campaign revision,
            not predicted engagement.
          </Text>
        </View>
        <Pill label="Observed outcomes" tone="info" />
      </View>

      {query.isLoading ? (
        <Copy color={t.fgMuted}>Loading immutable poll receipts…</Copy>
      ) : query.isError ? (
        <View style={{ gap: 5 }} accessibilityRole="alert">
          <Copy color={t.danger}>
            Poll receipts could not be verified. This is unknown, not zero
            responses.
          </Copy>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry campaign poll receipts"
            onPress={() => void query.refetch()}
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
              Retry
            </Text>
          </Pressable>
        </View>
      ) : receipts.length === 0 ? (
        <View style={{ gap: 4 }}>
          <Copy color={t.fgMuted}>
            No immutable poll response contract has been materialized.
          </Copy>
          <Copy color={t.fgSubtle}>
            Mobile remains read-only and does not guess the frozen revision. On
            web or desktop, save the campaign, then choose Freeze revision and
            materialize polls. That flow reads poll keys back from the exact
            immutable semantic revision and requires two-step confirmation.
          </Copy>
        </View>
      ) : (
        receipts.map((receipt) => (
          <PollReceipt key={receipt.definition.id} receipt={receipt} />
        ))
      )}
    </Card>
  );
}

function PollReceipt({ receipt }: { receipt: CampaignPollReceipt }) {
  const { t } = useTheme();
  const { definition, tally } = receipt;
  const counted = tally.options.reduce(
    (sum, option) => sum + option.counted,
    0,
  );
  const excluded =
    tally.machineExcluded +
    tally.unclassifiedExcluded +
    tally.voidedMultiOption +
    tally.supersededChoices +
    tally.previewedOnly;
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
        gap: 7,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.semibold,
        }}
      >
        {definition.question}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Pill
          label={
            definition.twoStepRequired
              ? "Two-step confirmation"
              : "Single-step — scanner safety not assured"
          }
          tone={definition.twoStepRequired ? "success" : "warning"}
        />
        <Pill label={`${counted} counted human`} tone="success" />
        <Pill
          label={`${excluded} excluded`}
          tone={excluded > 0 ? "warning" : "neutral"}
        />
      </View>
      {tally.options.map((option) => (
        <View
          key={option.optionKey}
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Copy color={t.fgMuted}>{option.label}</Copy>
          <Copy color={t.fg}>{option.counted} counted human</Copy>
        </View>
      ))}
      <ReceiptValue
        label="Machine excluded"
        value={String(tally.machineExcluded)}
      />
      <ReceiptValue
        label="Unclassified excluded"
        value={String(tally.unclassifiedExcluded)}
      />
      <ReceiptValue
        label="Multi-option voided"
        value={String(tally.voidedMultiOption)}
      />
      <ReceiptValue
        label="Superseded choices"
        value={String(tally.supersededChoices)}
      />
      <ReceiptValue
        label="Preview-only legacy"
        value={String(tally.previewedOnly)}
      />
      <ReceiptValue
        label="Immutable submission receipts"
        value={String(tally.submissionReceipts)}
      />
      <Copy color={t.fgSubtle}>
        Only explicit human classifications enter option counts. Machine,
        unknown, multi-option, superseded, and preview-only evidence stays
        visible and excluded; missing classification never defaults to human.
      </Copy>
      <ReceiptValue
        label="Frozen revision"
        value={definition.contentRevisionId}
      />
      <ReceiptValue
        label="Revision source hash"
        value={definition.contentRevisionSourceHash}
        hash
      />
      <ReceiptValue
        label="Poll contract SHA-256"
        value={definition.pollContractSha256}
        hash
      />
    </View>
  );
}

function Copy({ children, color }: { children: ReactNode; color: string }) {
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}
