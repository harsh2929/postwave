/**
 * AuditRowDetail — the whole event, on the sheet.
 *
 * A phone-width card can carry a verb, an actor and a timestamp. Everything
 * that actually settles a question during an investigation — what changed,
 * from which device, under which session, and whether what you are reading
 * has been masked — did not fit and so was never rendered at all.
 *
 * The three things this sheet exists to say out loud:
 *   - WHAT CHANGED. buildAuditMetadataView turns the metadata blob into a
 *     per-leaf before → after diff, so "settings.notify.email: true → false"
 *     replaces two dumped objects.
 *   - WHAT YOU ARE NOT SEEING. `redactedFields` names the paths the server
 *     masked and `hasEncryptedMetadata` says a sealed side-blob exists. A
 *     redacted value read as truth is a compliance failure, so the sheet
 *     states the masking before it shows any values.
 *   - PROVENANCE. IP, user agent, session id and the full resource id —
 *     the identifiers you correlate against, rendered selectable so they
 *     can be copied out.
 */
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Pill } from "@/components/Pill";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import type { AuditAnomaly, AuditRow } from "@/hooks/useAudit";
import { auditActionLabel } from "@/lib/auditActionLabel";
import { buildAuditMetadataView } from "@/lib/auditDiff";
import type { AuditWriteAccess } from "@/lib/auditForensics";
import { classifyAction, severityLabel, severityTone } from "@/lib/auditSeverity";
import { dateTime, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  AuditFactRow,
  AuditMetadataBlock,
  SheetHeader,
} from "./AuditSheetParts";
import { AuditRowForensics } from "./AuditRowForensics";
import { AuditRowGovernance } from "./AuditRowGovernance";

/**
 * The audit tab's investigation context. OPTIONAL on purpose: the NLQ answer
 * sheet re-uses this detail over rows from a NARROWER projection, where the
 * forensic reads and writes would fire against ids the caller cannot vouch
 * for — there the sheet stays display-only, exactly as before.
 */
export interface AuditRowInvestigationContext {
  /** Session owner/admin — gates the inclusion-proof mount (ScopeAdmin). */
  isAdmin: boolean;
  online: boolean;
  /** Open the request-chain sheet seeded with this correlation id. */
  onTrace: (requestId: string) => void;
  unmaskAccess: AuditWriteAccess;
  retentionAccess: AuditWriteAccess;
}

export interface AuditRowDetailProps {
  row: AuditRow | null;
  anomaly?: AuditAnomaly | undefined;
  /** False when the viewer lacks audit:read_pii — masked values stay masked. */
  canReadPii: boolean;
  /**
   * Said when the row reaching this sheet came from a NARROWER projection than
   * the audit list's.
   *
   * The redaction / legal-hold / encrypted-metadata badges above are drawn from
   * fields a caller may simply not have selected — `runFilteredAudit`, behind
   * the natural-language endpoint, does not. Without this note their absence
   * reads as "nothing was masked", which on a compliance surface is the one
   * false reassurance this sheet exists to prevent.
   */
  provenanceNote?: string | undefined;
  /** Present only on the audit tab — see AuditRowInvestigationContext. */
  investigation?: AuditRowInvestigationContext | undefined;
  onClose: () => void;
}

export function AuditRowDetail({
  row,
  anomaly,
  canReadPii,
  provenanceNote,
  investigation,
  onClose,
}: AuditRowDetailProps) {
  const { t } = useTheme();
  const view = row ? buildAuditMetadataView(row.metadata) : null;
  const severity = row ? classifyAction(row.action) : null;
  const redacted = row?.redactedFields ?? [];
  const actionLabel = auditActionLabel(row?.action);

  return (
    <ReducedMotionModal
      visible={Boolean(row)}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        accessibilityLabel="Audit event detail"
      >
        <SheetHeader title="Event detail" onClose={onClose} />
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 14 }}
        >
          {row ? (
            <>
              <View style={{ gap: 8 }}>
                <Text
                  {...typeCap("heading")}
                  style={{
                    color: t.fg,
                    fontWeight: "700",
                    fontFamily: FONT.bold,
                    ...typeStyle("heading"),
                  }}
                >
                  {actionLabel}
                </Text>
                <View
                  style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}
                >
                  {severity && severity !== "ops" ? (
                    <Pill
                      label={severityLabel(severity)}
                      tone={severityTone(severity)}
                    />
                  ) : null}
                  {anomaly ? (
                    <Pill
                      label={`Risk ${anomaly.bucket}`}
                      tone={anomaly.bucket === "high" ? "danger" : "warning"}
                    />
                  ) : null}
                  {row.legalHold ? <Pill label="Legal hold" tone="info" /> : null}
                  {redacted.length > 0 ? (
                    <Pill label="Redacted" tone="warning" />
                  ) : null}
                </View>
              </View>

              <ProvenanceNote note={provenanceNote} />

              {redacted.length > 0 || row.hasEncryptedMetadata ? (
                <RedactionNotice
                  fields={redacted}
                  encrypted={Boolean(row.hasEncryptedMetadata)}
                  canReadPii={canReadPii}
                  revealContext={
                    investigation
                      ? investigation.unmaskAccess.allowed
                        ? "in-app"
                        : "explained-below"
                      : "elsewhere"
                  }
                />
              ) : null}

              <EventFactList
                row={row}
                anomaly={anomaly}
                actionLabel={actionLabel}
              />

              {view ? <AuditMetadataBlock view={view} /> : null}

              {investigation ? (
                <>
                  <AuditRowForensics
                    row={row}
                    anomaly={anomaly}
                    isAdmin={investigation.isAdmin}
                    canReadPii={canReadPii}
                    online={investigation.online}
                    onTrace={investigation.onTrace}
                  />
                  <AuditRowGovernance
                    row={row}
                    unmaskAccess={investigation.unmaskAccess}
                    retentionAccess={investigation.retentionAccess}
                  />
                </>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

/**
 * The correlation identifiers, one per row and each selectable — extracted
 * from the sheet body so AuditRowDetail itself stays inside the complexity
 * budget now that it also mounts the forensic and governance sections.
 */
function EventFactList({
  row,
  anomaly,
  actionLabel,
}: {
  row: AuditRow;
  anomaly: AuditAnomaly | undefined;
  actionLabel: string;
}) {
  return (
    <View style={{ gap: 2 }}>
      <EventKeyFact action={row.action} label={actionLabel} />
      <AuditFactRow label="When" value={dateTime(row.at)} />
      <AuditFactRow
        label="Actor"
        value={
          row.actorLabel
            ? `${row.actorLabel} (${row.actorType || "unknown"})`
            : row.actorType || "unknown"
        }
      />
      {row.resourceType ? (
        <AuditFactRow
          label="Resource"
          value={`${row.resourceType}${
            row.resourceId ? ` · ${row.resourceId}` : ""
          }`}
          selectable
        />
      ) : null}
      {row.ip ? <AuditFactRow label="IP" value={row.ip} selectable /> : null}
      {row.userAgent ? (
        <AuditFactRow label="Device" value={row.userAgent} selectable />
      ) : null}
      {row.sessionId ? (
        <AuditFactRow label="Session" value={row.sessionId} selectable />
      ) : null}
      {typeof row.retentionOverrideDays === "number" ? (
        <AuditFactRow
          label="Retention"
          value={`${plural(row.retentionOverrideDays, "day")} (override)`}
        />
      ) : null}
      {anomaly?.mitreTechniques?.length ? (
        <AuditFactRow label="MITRE" value={anomaly.mitreTechniques.join(", ")} />
      ) : null}
    </View>
  );
}

function EventKeyFact({
  action,
  label,
}: {
  action: string | undefined;
  label: string;
}) {
  const rawAction = action?.trim();
  if (!rawAction || rawAction === label) return null;
  return <AuditFactRow label="Event key" value={rawAction} selectable />;
}

/**
 * The projection caveat, as its own component so the absence branch lives here
 * rather than adding a conditional to the sheet's already-dense render.
 */
function ProvenanceNote({ note }: { note: string | undefined }) {
  const { t } = useTheme();
  if (!note) return null;
  return (
    <Text
      accessibilityRole="alert"
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        fontFamily: FONT.regular,
        ...typeStyle("bodySmall"),
      }}
    >
      {note}
    </Text>
  );
}

function RedactionNotice({
  fields,
  encrypted,
  canReadPii,
  revealContext,
}: {
  fields: readonly string[];
  encrypted: boolean;
  canReadPii: boolean;
  /**
   * "in-app": this sheet's governance section offers the reveal below.
   * "explained-below": the governance section states why not (offline, role).
   * "elsewhere": display-only mount (NLQ) — the audit tab is where reveals live.
   */
  revealContext: "in-app" | "explained-below" | "elsewhere";
}) {
  const { t } = useTheme();
  const lines: string[] = [];
  if (fields.length > 0) {
    lines.push(
      `${plural(fields.length, "field")} were masked before this event was stored: ${fields.join(", ")}.`,
    );
  }
  if (encrypted) {
    lines.push(
      !canReadPii
        ? "An encrypted metadata blob exists for this event. Revealing it needs the audit:read_pii scope."
        : revealContext === "in-app"
          ? "An encrypted metadata blob exists for this event. It can be revealed below; the reveal is recorded as PII access."
          : revealContext === "explained-below"
            ? "An encrypted metadata blob exists for this event."
            : "An encrypted metadata blob exists for this event. Open it from the audit log to reveal it.",
    );
  }
  const body = lines.join(" ");
  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`Partially masked. ${body}`}
      style={{
        backgroundColor: t.bgSubtle,
        borderColor: t.warning,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        gap: 4,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          fontWeight: "700",
          fontFamily: FONT.bold,
          ...typeStyle("callout"),
        }}
      >
        Partially masked
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          ...typeStyle("bodySmall"),
        }}
      >
        {body}
      </Text>
    </View>
  );
}
