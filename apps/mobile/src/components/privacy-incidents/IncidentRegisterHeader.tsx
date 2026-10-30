/**
 * IncidentRegisterHeader — everything above the incident rows.
 *
 * Split out of PrivacyIncidentsScreen with no change of behaviour: the
 * desktop-scope notice, the two staleness banners, the register-wide headline,
 * the truncation caveat, and the write-side pause notice.
 *
 * THE TWO BANNERS ARE NOT INTERCHANGEABLE. "refreshing" says the shown rows
 * and countdowns are last-known while a live read is in flight; "stale" says
 * the live read FAILED and offers the retry. Collapsing them would let a
 * failed refresh read as a pending one on a surface where the numbers are a
 * countdown.
 */
import { Text, View } from "react-native";

import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import type { PrivacyIncidentsScreenController } from "@/hooks/usePrivacyIncidentsScreen";
import { FONT } from "@/lib/fonts";
import {
  INCIDENT_DESKTOP_NOTICE,
  incidentSampleCaveat,
} from "@/lib/privacyIncidentCopy";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type Props = Pick<
  PrivacyIncidentsScreenController,
  "dataState" | "headline" | "incidents" | "page" | "rows" | "write"
>;

export function IncidentRegisterHeader({
  dataState,
  headline,
  incidents,
  page,
  rows,
  write,
}: Props) {
  return (
    <View>
      <MobileScopeNotice body={INCIDENT_DESKTOP_NOTICE} />
      {dataState === "refreshing" ? (
        <StaleDataBanner
          message="Refreshing the live register — shown rows and countdowns are from the last successful read until verification completes."
          accessibilityLabel="Refreshing the live breach register. Shown incident rows and countdowns are from the last successful read until verification completes."
        />
      ) : null}
      {dataState === "stale" ? (
        <StaleDataBanner
          message="Couldn’t refresh the live register — shown rows and countdowns are stale and may be out of date."
          accessibilityLabel="The live breach register could not be refreshed. Shown incident rows and countdowns are stale and may be out of date."
          onRetry={() => void incidents.refetch()}
        />
      ) : null}
      {headline ? <Headline text={headline} /> : null}
      {page?.truncated ? (
        <Headline tone="muted" text={incidentSampleCaveat(rows.length)} />
      ) : null}
      {write.known && write.notice ? (
        <MobileScopeNotice title="State changes paused" body={write.notice} />
      ) : null}
    </View>
  );
}

/**
 * One register-wide claim, said in words rather than shown in a colour.
 *
 * Only the danger tone takes `role="alert"`: crossing the legacy operational
 * target is worth announcing, while an incident that has merely been open a
 * while is read in turn. Neither state is presented as a legal determination.
 */
function Headline({
  text,
  tone = "danger",
}: {
  text: string;
  tone?: "danger" | "muted";
}) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole={tone === "danger" ? "alert" : "text"}
      accessibilityLiveRegion="polite"
      accessibilityLabel={text}
      {...typeCap("bodySmall")}
      style={{
        color: tone === "danger" ? t.danger : t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.semibold,
        marginBottom: 10,
      }}
    >
      {text}
    </Text>
  );
}
