/**
 * VanityPathsCard — this campaign's short addresses, and what they do not prove.
 *
 * ASSURE#9: web and desktop render this panel and mobile had nothing, including
 * the caveat.
 *
 * The caveat is rendered UNCONDITIONALLY and first, exactly as the web panel does,
 * and for the reason that module records: "the whole point of F04 is an arrival
 * signal that is honest about what it does not prove." Showing arrivals without it
 * is the failure this feature was designed to avoid.
 *
 * Creating a short address stays on the web: the slug becomes a permanent public
 * URL printed inside an email, which is authoring, not an on-call act.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import {
  useCampaignDirectAttributionEvidence,
  useVanityPaths,
} from "@/hooks/useVanityPaths";
import { forwardArrow } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import {
  campaignEvidenceOutcomeLabel,
  outcomeVisibilityCaveat,
  readershipCaveat,
  vanityDestination,
} from "@/lib/vanityPaths";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function VanityPathsCard({ campaignId }: { campaignId: string }) {
  const { t } = useTheme();
  const query = useVanityPaths(campaignId);
  const evidence = useCampaignDirectAttributionEvidence(campaignId);
  const rows = Array.isArray(query.data) ? query.data : [];
  // Array.isArray at both levels rather than `?? []`: the coalesce only covers
  // an absent `data`, and every page's `items` is a wire field nothing
  // guarantees the shape of.
  const evidenceRows = Array.isArray(evidence.data?.pages)
    ? evidence.data.pages.flatMap((page) =>
        Array.isArray(page.items) ? page.items : [],
      )
    : [];
  const evidenceSummary = evidence.data?.pages[0]?.summary;
  const evidenceTotal = evidence.data?.pages[0]?.total;
  if (rows.length === 0 && evidence.isSuccess && evidenceTotal === 0) {
    return null;
  }

  return (
    <View style={{ gap: 8, marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Short addresses
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {readershipCaveat()}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.warning,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {outcomeVisibilityCaveat()}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
          marginTop: 4,
        }}
      >
        Audited direct-attribution evidence
      </Text>
      {evidence.isPending ? (
        <Text
          {...typeCap("caption")}
          accessibilityState={{ busy: true }}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Loading attribution receipts…
        </Text>
      ) : evidence.isError || !evidenceSummary ? (
        <Text
          {...typeCap("caption")}
          accessibilityRole="alert"
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Allocation, visit, redemption, and linked-outcome evidence could not
          be loaded. This is not the same as zero evidence.
        </Text>
      ) : (
        <>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {evidenceSummary.codeAllocations} code allocations ·{" "}
            {evidenceSummary.codeRedemptions} redemptions ·{" "}
            {evidenceSummary.noClickRedemptions} no-click observations ·{" "}
            {evidenceSummary.vanityVisits} short-address requests ·{" "}
            {evidenceSummary.codeLinkedOutcomes +
              evidenceSummary.vanityLinkedOutcomes}{" "}
            linked outcomes
          </Text>
          {evidenceSummary.clickEvidenceUnavailable > 0 ? (
            <Text
              {...typeCap("caption")}
              accessibilityRole="alert"
              style={{
                color: t.warning,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {evidenceSummary.clickEvidenceUnavailable} historical redemption
              click observation
              {evidenceSummary.clickEvidenceUnavailable === 1
                ? " is"
                : "s are"}{" "}
              unavailable and remain unknown.
            </Text>
          ) : null}
          {evidenceRows.length === 0 ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              The authoritative register contains no allocation or short-address
              receipts for this campaign.
            </Text>
          ) : (
            evidenceRows.map((item) => (
              <View
                key={item.kind + ":" + item.evidenceId}
                style={{
                  borderTopColor: t.borderSubtle,
                  borderTopWidth: 1,
                  paddingTop: 8,
                  gap: 2,
                }}
              >
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fg,
                    ...typeStyle("caption"),
                    fontFamily: FONT.semibold,
                  }}
                >
                  {item.kind === "code_allocation"
                    ? "Code allocation"
                    : "Short-address request"}{" "}
                  · {item.status}
                </Text>
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  Receipt {item.evidenceId.slice(0, 8)}
                  {item.kind === "code_allocation" && item.redemptionId !== null
                    ? " · click observation: " +
                      (item.linkedWithoutRecordedAssignmentClick === null
                        ? "unavailable"
                        : item.linkedWithoutRecordedAssignmentClick
                          ? "no preceding assignment click"
                          : "preceding assignment click")
                    : ""}
                </Text>
                {campaignEvidenceOutcomeLabel(
                  item.conversionId,
                  item.amountCents,
                  item.currency,
                ) !== null ? (
                  <Text
                    {...typeCap("caption")}
                    style={{
                      color: t.fgSubtle,
                      ...typeStyle("caption"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    {campaignEvidenceOutcomeLabel(
                      item.conversionId,
                      item.amountCents,
                      item.currency,
                    )}
                  </Text>
                ) : null}
              </View>
            ))
          )}
          {evidence.hasNextPage ? (
            <Pressable
              onPress={() => void evidence.fetchNextPage()}
              disabled={evidence.isFetchingNextPage}
              accessibilityRole="button"
              accessibilityLabel="Load more direct attribution receipts"
              accessibilityState={{
                disabled: evidence.isFetchingNextPage,
              }}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: evidence.isFetchingNextPage ? t.fgSubtle : t.accent,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                {evidence.isFetchingNextPage
                  ? "Loading more…"
                  : "Load more attribution receipts"}
              </Text>
            </Pressable>
          ) : null}
        </>
      )}
      {rows.map((path) => (
        <View
          key={path.id}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 10,
            gap: 2,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
                flexShrink: 1,
              }}
              numberOfLines={1}
            >
              {path.publicPath}
            </Text>
            {path.status ? (
              <Pill
                label={path.status}
                tone={path.status === "active" ? "success" : "neutral"}
              />
            ) : null}
          </View>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
            numberOfLines={1}
          >
            {forwardArrow()} {vanityDestination(path)}
          </Text>
        </View>
      ))}
    </View>
  );
}
