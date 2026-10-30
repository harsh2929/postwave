/**
 * AuditAlertIncidentList — the external tickets one alert rule has opened.
 *
 * WHY THIS IS THE REASON THE SURFACE IS WORTH A PHONE. The rule list answers
 * "is the detection switched on". The fire list answers "did the last delivery
 * work". Only this answers "and did anyone DO anything about it" — and an
 * unresolved ServiceNow incident from four days ago is the only item here that
 * genuinely warrants interrupting somebody.
 *
 * THE THREE STATES ARE NOT COLLAPSIBLE. Like the fire list, an empty array from
 * `GET /{id}/incidents` means "this rule has never opened a ticket"; a fetch
 * that has not landed, or one that failed, means nothing at all. Rendering the
 * last two as the first is an all-clear this component refuses to give — so it
 * takes `loading` and `failed` explicitly.
 *
 * A TICKET WITH NO SYNCED STATUS IS NOT A CLOSED TICKET. `incident_status` is a
 * nullable column fed by an external system's webhook; `incidentPresentation`
 * renders the empty case as "Status not synced" and counts it as outstanding.
 *
 * THE LINK IS FILTERED, NOT TRUSTED. `incident_url` can be overridden by
 * whatever POSTs the inbound webhook, so only `incidentLink`'s https-only
 * answer ever reaches `Linking.openURL`.
 */
import { Linking, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { TextLink } from "@/components/TextLink";
import {
  incidentLink,
  incidentPresentation,
  incidentSystemLabel,
  outstandingIncidentCount,
  type AuditAlertIncident,
} from "@/lib/auditAlertIncidents";
import { EMDASH, dateTime, num, plural, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditAlertIncidentListProps {
  incidents: readonly AuditAlertIncident[];
  loading: boolean;
  failed: boolean;
  /** Non-null when the server withheld older incidents. */
  truncated: boolean;
  now: number;
}

export function AuditAlertIncidentList({
  incidents,
  loading,
  failed,
  truncated,
  now,
}: AuditAlertIncidentListProps) {
  if (failed) {
    return (
      <Note
        tone="danger"
        text="The linked incidents couldn't be loaded, so whether any are still open is unknown."
      />
    );
  }
  if (loading) {
    return <Note tone="muted" text="Checking linked incidents…" />;
  }
  if (incidents.length === 0) {
    return (
      <Note
        tone="muted"
        text="No tickets have been opened by this rule. Only the ServiceNow, Jira and PagerDuty channels create them."
      />
    );
  }

  const outstanding = outstandingIncidentCount(incidents);
  return (
    <View style={{ gap: 8 }}>
      <Note
        tone={outstanding > 0 ? "danger" : "muted"}
        text={
          outstanding > 0
            ? `${plural(outstanding, "incident")} still outstanding.`
            : "Every linked incident has been resolved or closed."
        }
      />
      {incidents.map((incident) => (
        <IncidentCard key={incident.id} incident={incident} now={now} />
      ))}
      {truncated ? (
        <Note
          tone="muted"
          text="Older incidents exist beyond this page — open the rule on desktop to page through the full history."
        />
      ) : null}
    </View>
  );
}

function IncidentCard({
  incident,
  now,
}: {
  incident: AuditAlertIncident;
  now: number;
}) {
  const { t } = useTheme();
  const view = incidentPresentation(incident);
  const system = incidentSystemLabel(incident.externalSystem);
  const link = incidentLink(incident);
  const synced = incident.lastSyncedAt
    ? relativeTime(incident.lastSyncedAt, { now })
    : null;

  return (
    <View
      accessible
      accessibilityLabel={`${system} ${incident.externalIncidentId}. ${view.spoken}${
        synced ? ` Last synced ${synced}.` : " It has never been synced."
      }${incident.auditId === null ? "" : ` Audit event ${incident.auditId}.`}`}
      style={{
        backgroundColor: t.bgSubtle,
        borderColor: view.outstanding ? t.danger : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 4,
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
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {system} · {incident.externalIncidentId}
        </Text>
        <Pill label={view.label} tone={view.tone} />
      </View>

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {incident.auditId === null
          ? `Audit event ${EMDASH}`
          : `Audit event ${num(incident.auditId)}`}
        {" · "}
        {/* Absence is not zero: a ticket that has never synced says so rather
            than borrowing created_at and implying a round-trip happened. */}
        {incident.lastSyncedAt
          ? `synced ${dateTime(incident.lastSyncedAt)}`
          : "never synced"}
      </Text>

      {link ? (
        <TextLink
          onPress={() => void Linking.openURL(link).catch(() => undefined)}
          accessibilityLabel={`Open ${incident.externalIncidentId} in ${system}`}
          // Colour + weight only: TextLink already carries the `body` role's
          // size AND its matching Dynamic Type ceiling, and re-sizing here
          // without re-capping would pair one role's metrics with another's.
          textStyle={{ color: t.accent, fontFamily: FONT.semibold }}
        >
          {`Open in ${system}`}
        </TextLink>
      ) : null}
    </View>
  );
}

function Note({ text, tone }: { text: string; tone: "muted" | "danger" }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityLiveRegion="polite"
      {...typeCap("bodySmall")}
      style={{
        color: tone === "danger" ? t.danger : t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}
