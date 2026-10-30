/**
 * IncidentDetailFacts — the operational target, recorded scope, and explicit
 * jurisdiction-guidance release hold.
 *
 * List rows omit jurisdiction resolution. Detail returns only a release-hold
 * marker and code/name recognition metadata. This component never converts
 * those references into duties, recipients, or legal deadlines.
 */
import { Text, View } from "react-native";

import { Skeleton } from "@/components/Skeleton";
import { EMDASH, dateTime, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { incidentSubjectCount } from "@/lib/privacyIncidentCopy";
import { incidentClock } from "@/lib/privacyIncidentPolicy";
import type {
  PrivacyIncident,
  PrivacyIncidentDetail,
} from "@/lib/privacyIncidents";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface IncidentDetailFactsProps {
  incident: PrivacyIncident;
  detail: PrivacyIncidentDetail | null;
  detailLoading: boolean;
  detailFailed: boolean;
  now: number;
}

export function IncidentDetailFacts(props: IncidentDetailFactsProps) {
  const { incident, detail, now } = props;
  const clock = incidentClock(incident, now);
  const subjects = incidentSubjectCount(incident);

  return (
    <View style={{ gap: 12, marginTop: 14 }}>
      <Fact
        label="Operational target"
        value={
          incident.deadlineAt
            ? `${clock.label} · due ${dateTime(incident.deadlineAt)}`
            : EMDASH
        }
        spoken={clock.spoken}
        tone={clock.state === "overdue" ? "danger" : undefined}
      />
      <Fact
        label="Detected"
        value={
          incident.detectedAt
            ? `${relativeTime(incident.detectedAt, { now })} · ${dateTime(incident.detectedAt)}`
            : EMDASH
        }
        spoken={incident.detectedAt ? undefined : "Detection time not recorded"}
      />
      <Fact
        label="Counsel sign-off"
        value={
          incident.counselSignoffAt
            ? `${incident.signoffBy || "Recorded"} · ${dateTime(incident.counselSignoffAt)}`
            : "Not recorded"
        }
        spoken={
          incident.counselSignoffAt
            ? `Legacy sign-off field recorded${incident.signoffBy ? ` by ${incident.signoffBy}` : ""}; this is not an authenticated approval receipt`
            : "No authenticated counsel approval receipt is available"
        }
      />
      <Fact
        label="People affected"
        value={subjects.label}
        spoken={subjects.spoken}
      />
      <Fact
        label="Data categories"
        value={
          incident.affectedDataCategories.length > 0
            ? incident.affectedDataCategories.join(", ")
            : EMDASH
        }
        spoken={
          incident.affectedDataCategories.length > 0
            ? undefined
            : "No data categories recorded"
        }
      />
      <Fact
        label="Regions"
        value={
          incident.affectedRegions.length > 0
            ? incident.affectedRegions.join(", ")
            : EMDASH
        }
        spoken={
          incident.affectedRegions.length > 0
            ? undefined
            : "No affected regions recorded"
        }
      />

      <JurisdictionGuidance
        detail={detail}
        loading={props.detailLoading}
        failed={props.detailFailed}
      />
    </View>
  );
}

function JurisdictionGuidance({
  detail,
  loading,
  failed,
}: {
  detail: PrivacyIncidentDetail | null;
  loading: boolean;
  failed: boolean;
}) {
  const { t } = useTheme();
  if (failed) {
    return (
      <Fact
        label="Jurisdiction guidance"
        value="Could not be loaded. No legal conclusion is available."
        tone="danger"
      />
    );
  }
  if (!detail || loading) {
    return (
      <View
        accessible
        accessibilityLabel="Loading jurisdiction release-hold status"
      >
        <FactLabel label="Jurisdiction guidance" />
        <View style={{ marginTop: 4 }}>
          <Skeleton height={16} width="80%" />
        </View>
      </View>
    );
  }
  const resolution = detail.jurisdictionResolution;
  if (!resolution) {
    return (
      <Fact
        label="Jurisdiction guidance"
        value="The server did not return the required release-hold contract. No legal conclusion is available."
        tone="danger"
      />
    );
  }
  const recognized =
    resolution.recognized.length > 0
      ? `Recognized selection metadata: ${resolution.recognized.map((entry) => entry.code).join(", ")}.`
      : "No submitted jurisdiction code was recognized.";
  const unknown =
    resolution.unknown.length > 0
      ? `Unrecognized codes: ${resolution.unknown.join(", ")}.`
      : "";
  const body =
    `Legal obligation guidance is release-held; this API does not determine duties, recipients, or deadlines. ${recognized} ${unknown}`.trim();
  return (
    <View accessible accessibilityLabel={`Jurisdiction guidance. ${body}`}>
      <FactLabel label="Jurisdiction guidance" />
      <Text
        {...typeCap("body")}
        style={{
          color: t.warning,
          ...typeStyle("body"),
          fontFamily: FONT.regular,
          marginTop: 2,
        }}
      >
        {body}
      </Text>
    </View>
  );
}

function FactLabel({ label }: { label: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.semibold,
        letterSpacing: 0.6,
        textTransform: "uppercase",
      }}
    >
      {label}
    </Text>
  );
}

function Fact({
  label,
  value,
  spoken,
  tone,
}: {
  label: string;
  value: string;
  spoken?: string | undefined;
  tone?: "danger" | undefined;
}) {
  const { t } = useTheme();
  return (
    <View accessible accessibilityLabel={`${label}: ${spoken ?? value}`}>
      <FactLabel label={label} />
      <Text
        {...typeCap("body")}
        style={{
          color: tone === "danger" ? t.danger : t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.regular,
          marginTop: 2,
        }}
      >
        {value}
      </Text>
    </View>
  );
}
