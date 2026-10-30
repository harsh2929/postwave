/**
 * AuditRowCard — one event in the log.
 *
 * Three things this card must never do, all of which it used to:
 *   - Read as an undifferentiated stream to VoiceOver. It is now one
 *     grouped element per event with a composed label, matching every
 *     sibling governance card.
 *   - Show a value that has been silently redacted as if it were truth.
 *     A `redacted` badge appears whenever the server masked fields.
 *   - Hide that the row is under legal hold, or that a UEBA scorer
 *     flagged it.
 *
 * Tapping opens the detail sheet — the metadata diff, user agent, session
 * and full identifiers that do not fit a phone-width card.
 */
import { memo } from "react";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import type { AuditAnomaly, AuditRow } from "@/hooks/useAudit";
import { auditActionLabel } from "@/lib/auditActionLabel";
import { auditMetadataSummary, buildAuditMetadataView } from "@/lib/auditDiff";
import {
  classifyAction,
  severityLabel,
  severityTone,
} from "@/lib/auditSeverity";
import { dateTime, time } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function anomalyPill(
  anomaly: AuditAnomaly | undefined,
): { label: string; tone: "danger" | "warning" } | null {
  if (!anomaly) return null;
  if (anomaly.bucket === "high") return { label: "Risk", tone: "danger" };
  if (anomaly.bucket === "med") return { label: "Watch", tone: "warning" };
  return null;
}

export interface AuditRowCardProps {
  row: AuditRow;
  anomaly?: AuditAnomaly | undefined;
  /** True when rows are grouped under a day header — show time only. */
  timeOnly?: boolean;
  onOpen: (row: AuditRow) => void;
}

function AuditRowCardImpl({
  row: r,
  anomaly,
  timeOnly,
  onOpen,
}: AuditRowCardProps) {
  const { t } = useTheme();
  const severity = classifyAction(r.action);
  const actionLabel = auditActionLabel(r.action);
  const risk = anomalyPill(anomaly);
  const redactedCount = r.redactedFields?.length ?? 0;
  const stamp = timeOnly ? time(r.at, "—") : dateTime(r.at, "—");
  const metaSummary = auditMetadataSummary(buildAuditMetadataView(r.metadata));

  // One composed sentence per event. Without this VoiceOver walks six
  // fragments with no boundary between one event and the next — on a
  // hundred-row list that is the difference between usable and unusable.
  const spoken = [
    actionLabel,
    severity !== "ops" ? severityLabel(severity) : null,
    risk ? `${risk.label} flagged` : null,
    redactedCount > 0 ? "contains redacted fields" : null,
    r.legalHold ? "under legal hold" : null,
    r.resourceType
      ? `${r.resourceType}${r.resourceId ? ` ${r.resourceId}` : ""}`
      : null,
    r.actorType || "unknown actor",
    r.actorLabel ?? null,
    stamp,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint="Opens the full event detail"
      onPress={() => onOpen(r)}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          numberOfLines={2}
          {...typeCap("body")}
          style={{
            color: t.fg,
            fontWeight: "600",
            fontFamily: FONT.semibold,
            flex: 1,
            ...typeStyle("body"),
          }}
        >
          {actionLabel}
        </Text>
        {risk ? <Pill label={risk.label} tone={risk.tone} /> : null}
        {severity !== "ops" ? (
          <Pill label={severityLabel(severity)} tone={severityTone(severity)} />
        ) : null}
      </View>

      {r.resourceType ? (
        <Text
          numberOfLines={1}
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            marginTop: 2,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
          }}
        >
          {r.resourceType}
          {r.resourceId ? ` · ${r.resourceId.slice(0, 8)}` : ""}
        </Text>
      ) : null}

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginTop: 8,
          flexWrap: "wrap",
        }}
      >
        <Pill label={r.actorType || "unknown"} tone="neutral" />
        {redactedCount > 0 ? <Pill label="redacted" tone="warning" /> : null}
        {r.legalHold ? <Pill label="on hold" tone="info" /> : null}
        {r.actorLabel ? (
          <Text
            numberOfLines={1}
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              flexShrink: 1,
              fontFamily: FONT.regular,
              ...typeStyle("bodySmall"),
            }}
          >
            {r.actorLabel}
          </Text>
        ) : null}
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginTop: 8,
          flexWrap: "wrap",
        }}
      >
        <Text
          {...typeCap("numeric")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
            ...typeStyle("numeric"),
          }}
        >
          {stamp}
        </Text>
        {r.ip ? (
          <Text
            numberOfLines={1}
            {...typeCap("numeric")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
              ...typeStyle("numeric"),
            }}
          >
            {`· ${r.ip}`}
          </Text>
        ) : null}
        {metaSummary ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.accent,
              fontFamily: FONT.semibold,
              ...typeStyle("caption"),
            }}
          >
            {`· ${metaSummary}`}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export const AuditRowCard = memo(AuditRowCardImpl);
