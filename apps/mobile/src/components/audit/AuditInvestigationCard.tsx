/**
 * AuditInvestigationCard — one AI investigation, as a card an approver can
 * actually decide from.
 *
 * The card leads with the HYPOTHESES and the PROPOSED ACTIONS, not with a
 * confidence score. A percentage at the top of a card is read as a verdict;
 * the agent's own contract is that every finding cites at least one audit_log
 * id (`Result.Validate`, enforced twice server-side), so the citations are
 * the load-bearing part and the score is context.
 *
 * The "Moosewave will not execute this" disclosure sits ABOVE the buttons
 * rather than in a help sheet. It is the single most consequential thing on
 * the card: without it, an approver taps Approve on a list of account-
 * disabling actions and reasonably believes the incident is contained.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import {
  investigationConfidenceLabel,
  investigationStatusLabel,
  investigationStatusTone,
  investigationSummaryLine,
  type AuditInvestigation,
} from "@/lib/auditInvestigations";
import { relativeTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditInvestigationCardProps {
  investigation: AuditInvestigation;
  now: number;
  /** The decision controls, injected so this card stays presentational. */
  actions?: React.ReactNode;
}

export function AuditInvestigationCard({
  investigation: inv,
  now,
  actions,
}: AuditInvestigationCardProps) {
  const { t } = useTheme();
  const age = inv.created_at
    ? relativeTime(inv.created_at, { now, fallback: "" })
    : "";
  return (
    <View
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.surface,
        padding: 14,
        gap: 10,
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
            flex: 1,
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {`From audit event #${inv.seed_audit_id}${age ? ` · ${age}` : ""}`}
        </Text>
        <Pill
          label={investigationStatusLabel(inv.status)}
          tone={investigationStatusTone(inv.status)}
          size="sm"
        />
      </View>

      {inv.findings.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          No findings were recorded on this investigation.
        </Text>
      ) : (
        <View style={{ gap: 6 }}>
          {inv.findings.map((finding) => (
            <View key={finding.num} style={{ gap: 2 }}>
              <Text
                {...typeCap("body")}
                style={{
                  color: t.fg,
                  ...typeStyle("body"),
                  fontFamily: FONT.regular,
                }}
              >
                {`${finding.num}. ${finding.hypothesis}`}
              </Text>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {[
                  `cites ${finding.evidence_audit_ids?.length ?? 0} event${
                    (finding.evidence_audit_ids?.length ?? 0) === 1 ? "" : "s"
                  }`,
                  finding.mitre_techniques?.length
                    ? `MITRE ${finding.mitre_techniques.join(", ")}`
                    : "",
                  `confidence ${investigationConfidenceLabel(finding.confidence)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
          ))}
        </View>
      )}

      {inv.proposed_actions.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text
            accessibilityRole="header"
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontWeight: "700",
              fontFamily: FONT.semibold,
              letterSpacing: 0.4,
            }}
          >
            PROPOSED ACTIONS
          </Text>
          {inv.proposed_actions.map((action) => (
            <Text
              key={action.id}
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {`• ${action.action.replaceAll("_", " ")}${
                action.target_id ? ` — ${action.target_id}` : ""
              }${action.severity ? ` (${action.severity})` : ""}`}
            </Text>
          ))}
        </View>
      ) : null}

      <Text
        {...typeCap("caption")}
        accessibilityLabel={`Summary: ${investigationSummaryLine(inv)}. Overall confidence ${investigationConfidenceLabel(
          inv.confidence,
        )}.`}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {`${investigationSummaryLine(inv)} · confidence ${investigationConfidenceLabel(inv.confidence)}`}
      </Text>

      {inv.status === "rejected" && inv.rejection_reason ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {`Rejected: ${inv.rejection_reason}`}
        </Text>
      ) : null}

      {actions}
    </View>
  );
}
