/**
 * OmnichannelDetailSheet — the paths a definition declares, and what is wrong
 * with them.
 *
 * A SHEET RATHER THAN A ROUTE, on the same reasoning as LookalikeDetailSheet:
 * the rhythm is open → read → close, and it keeps the surface to one route file.
 *
 * IT OPENS WITHOUT MAKING A REQUEST. `ListCampaigns` hydrates every definition's
 * full path set in the same transaction as the header (repo.go:48-52), so
 * `GET /campaigns/{id}` would return bytes already on screen and give them a
 * second chance to disagree. The detail read exists in `api/omnichannel.ts` for
 * the row past the list's 200-row cap; it is not spent here.
 *
 * IT CHECKS THE DEFINITION AGAINST THE SERVER'S OWN RULES. `Validate` enforces
 * the RCS→SMS fallback and the 10000-basis-point traffic total on the VALIDATE
 * and CREATE routes only — nothing re-checks a row already in the table. So a
 * definition written before a rule, or written by something that skipped it, is
 * stored and served happily. Re-running the two cheap structural checks here is
 * the difference between a viewer and a mirror.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import {
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { Pill } from "@/components/Pill";
import { OmnichannelRuntimeNotice } from "@/components/omnichannel/OmnichannelRuntimeNotice";
import { FONT } from "@/lib/fonts";
import { dateTime } from "@/lib/format";
import {
  brokenFallbacks,
  channelSpan,
  pathStatusIsRuntimeClaim,
  trafficSplit,
  unknownChannels,
  type OmniCampaignDefinition,
  type OmniCatalog,
} from "@/lib/omnichannelDefinitions";
import { channelLabel } from "@/lib/omnichannelLabels";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function Line({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 12, paddingVertical: 5 }}>
      <Text
        {...typeCap("bodySmall")}
        style={{
          width: 116,
          color: t.fgSubtle,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          flex: 1,
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function Warning({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.warning,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.medium,
      }}
    >
      {children}
    </Text>
  );
}

export function OmnichannelDetailSheet({
  campaign,
  catalog,
  onClose,
}: {
  campaign: OmniCampaignDefinition | null;
  catalog: OmniCatalog | null;
  onClose: () => void;
}) {
  const { t } = useTheme();
  if (!campaign) return null;

  const split = trafficSplit(campaign);
  const broken = brokenFallbacks(campaign);
  const unknown = unknownChannels(campaign, catalog);
  const span = channelSpan(campaign);

  return (
    <ReducedMotionModal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: t.borderSubtle,
          }}
        >
          <Text
            {...typeCap("title")}
            numberOfLines={2}
            style={{
              flex: 1,
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.displaySemibold,
            }}
          >
            {campaign.name}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close definition"
            style={{ paddingHorizontal: 10, paddingVertical: 6 }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontFamily: FONT.medium,
              }}
            >
              Done
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }}
        >
          <OmnichannelRuntimeNotice
            runtime={campaign.runtime}
            statusIsLiveSounding={pathStatusIsRuntimeClaim(campaign.status)}
          />

          <View>
            <Line label="Status" value={campaign.status} />
            <Line label="Objective" value={campaign.objective} />
            <Line label="Recipients" value={campaign.recipientSnapshotMode} />
            <Line
              label="Send strategy"
              value={campaign.sendStrategyMode ?? "not declared"}
            />
            <Line
              label="Channels"
              value={span.map(channelLabel).join(", ") || "none"}
            />
            <Line
              label="Updated"
              value={campaign.updatedAt ? dateTime(campaign.updatedAt) : "—"}
            />
            {campaign.sourceCampaignId ? (
              <Line label="Cloned from" value={campaign.sourceCampaignId} />
            ) : null}
          </View>

          {broken.length > 0 || unknown.length > 0 || (split.declared && !split.balanced) ? (
            <View style={{ gap: 6 }}>
              {split.declared && !split.balanced ? (
                <Warning>
                  {`Traffic weights total ${split.totalBasisPoints} of 10000 basis points. A multi-path definition must total exactly 10000 to pass validation.`}
                </Warning>
              ) : null}
              {broken.length > 0 ? (
                <Warning>
                  {`Fallback wiring is incomplete on: ${broken.join(", ")}. An RCS path must name an SMS path to fall back to.`}
                </Warning>
              ) : null}
              {unknown.length > 0 ? (
                <Warning>
                  {`The channel schema does not list: ${unknown.join(", ")}.`}
                </Warning>
              ) : null}
            </View>
          ) : null}

          <View style={{ gap: 10 }}>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.semibold,
                textTransform: "uppercase",
                letterSpacing: 0.8,
              }}
            >
              Paths
            </Text>
            {split.entries.map(({ path, percent }) => (
              <View
                key={path.pathKey}
                style={{
                  gap: 6,
                  padding: 12,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: t.borderSubtle,
                  backgroundColor: t.surface,
                }}
              >
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                >
                  <Text
                    {...typeCap("body")}
                    numberOfLines={1}
                    style={{
                      flex: 1,
                      color: t.fg,
                      ...typeStyle("body"),
                      fontFamily: FONT.medium,
                    }}
                  >
                    {path.name}
                  </Text>
                  <Pill label={channelLabel(path.channel)} tone="accent" />
                  <Pill label={path.status} />
                </View>
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {[
                    // Absence renders as a stated absence, never as 0%.
                    percent === null ? "no traffic weight" : `${percent}% of traffic`,
                    path.messageTemplateId
                      ? "template bound"
                      : "no template bound",
                    path.fallbackPathKey
                      ? `falls back to ${path.fallbackPathKey}`
                      : null,
                    path.audienceKeys > 0
                      ? "path audience set"
                      : "no path audience",
                  ]
                    .filter((part): part is string => Boolean(part))
                    .join(" · ")}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}
