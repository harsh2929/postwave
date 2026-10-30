/**
 * AuditRowGovernance — the two per-event WRITES: revealing sealed metadata,
 * and the retention override / legal hold.
 *
 * Both are ONLINE-ONLY and never queued:
 *   - the reveal is itself recorded as PII access (audit_pii_unmask_history +
 *     an audit.pii_unmask row) the moment it runs — a queued reveal would be
 *     an access record minted out of context;
 *   - a hold that appears placed but was only queued is false
 *     evidence-preservation at exactly the moment preservation mattered.
 *
 * The reveal REQUIRES A REASON client-side (validUnmaskReason) even though
 * the server accepts an empty one: the access trail this write creates is a
 * compliance answer, and "" answers nothing. The reason sheet reuses
 * RejectReasonModal — the app's one "reason is mandatory" ceremony.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { RejectReasonModal } from "@/components/approvals/RejectReasonModal";
import type { AuditRow } from "@/hooks/useAudit";
import {
  useSetRetentionOverride,
  useUnmaskAuditEvent,
} from "@/hooks/useAuditForensics";
import { buildAuditMetadataView } from "@/lib/auditDiff";
import {
  RETENTION_OVERRIDE_PRESETS,
  validUnmaskReason,
  type AuditWriteAccess,
} from "@/lib/auditForensics";
import { plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { AuditAction } from "./AuditAction";
import { AuditMetadataBlock } from "./AuditSheetParts";

export interface AuditRowGovernanceProps {
  row: AuditRow;
  unmaskAccess: AuditWriteAccess;
  retentionAccess: AuditWriteAccess;
}

export function AuditRowGovernance({
  row,
  unmaskAccess,
  retentionAccess,
}: AuditRowGovernanceProps) {
  return (
    <View style={{ gap: 12 }}>
      {row.hasEncryptedMetadata ? (
        <UnmaskSection row={row} access={unmaskAccess} />
      ) : null}
      <RetentionSection row={row} access={retentionAccess} />
    </View>
  );
}

function UnmaskSection({
  row,
  access,
}: {
  row: AuditRow;
  access: AuditWriteAccess;
}) {
  const unmask = useUnmaskAuditEvent();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The revealed blob lives HERE, for exactly as long as the sheet does —
  // never in the query cache and never in a snapshot.
  const [revealed, setRevealed] = useState<{
    fields: string[];
    view: ReturnType<typeof buildAuditMetadataView>;
  } | null>(null);

  if (revealed) {
    return (
      <View style={{ gap: 6 }}>
        <GovernanceNote
          tone="warning"
          text={`Revealed ${plural(revealed.fields.length, "sealed field")}. This access was recorded in the audit trail.`}
        />
        <AuditMetadataBlock view={revealed.view} />
      </View>
    );
  }

  if (!access.allowed) {
    // Never a disabled button: the whole affordance is withheld, and one
    // caption explains the permission rule (a 403 must read as a rule).
    return access.known && access.notice ? (
      <GovernanceNote text={access.notice} />
    ) : null;
  }

  const submit = async () => {
    const reason = (draft ?? "").trim();
    if (!validUnmaskReason(reason)) {
      setError(
        "Say why this metadata is being revealed — the reason is recorded in the access trail.",
      );
      return;
    }
    try {
      const result = await unmask.mutateAsync({ auditId: row.id, reason });
      setDraft(null);
      setError(null);
      setRevealed({
        fields: result.unmaskedFields,
        view: buildAuditMetadataView(result.metadata),
      });
    } catch (err) {
      const status =
        err && typeof err === "object" && "status" in err
          ? Number((err as { status?: unknown }).status) || 0
          : 0;
      setError(
        status === 403
          ? "The server refused: your account is not permitted to reveal sealed metadata."
          : status === 503
            ? "This deployment has no decryption key configured, so sealed metadata cannot be revealed from any client."
            : "The reveal failed. Check your connection and try again.",
      );
    }
  };

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row" }}>
        <AuditAction
          label={unmask.isPending ? "Revealing…" : "Reveal sealed metadata"}
          hint="Decrypts this event's sealed fields. The reveal is recorded as PII access."
          emphasis
          disabled={unmask.isPending}
          onPress={() => {
            setError(null);
            setDraft("");
          }}
        />
      </View>
      <RejectReasonModal
        visible={draft !== null}
        label="Reveal sealed metadata"
        reason={draft ?? ""}
        busy={unmask.isPending}
        error={error}
        subtitle="Say why this event's sealed fields are being revealed. The reason is recorded in the PII access trail and cannot be edited later."
        submitAccessibilityLabel="Reveal the sealed metadata"
        onChangeReason={(reason) => {
          setError(null);
          setDraft(reason);
        }}
        onCancel={() => {
          setDraft(null);
          setError(null);
        }}
        onSubmit={() => void submit()}
      />
    </View>
  );
}

function RetentionSection({
  row,
  access,
}: {
  row: AuditRow;
  access: AuditWriteAccess;
}) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const override = useSetRetentionOverride();
  // The row prop is a snapshot from the list; reflect our own successful
  // writes locally so the sheet does not claim the old state until the list
  // refetch lands.
  const [localHold, setLocalHold] = useState<boolean | null>(null);
  const [localDays, setLocalDays] = useState<number | null>(null);
  const hold = localHold ?? Boolean(row.legalHold);
  const days = localDays ?? row.retentionOverrideDays ?? null;

  if (!access.allowed) {
    return access.known && access.notice ? (
      <GovernanceNote text={access.notice} />
    ) : null;
  }

  const flipHold = async () => {
    const next = !hold;
    const ok = await confirm({
      title: next ? "Place a legal hold?" : "Release the legal hold?",
      message: next
        ? "Retention rules stop applying to this event until the hold is released. Use it when this row is evidence that must not be purged."
        : "Retention rules apply again. If the event is older than the retention window it becomes eligible for the next purge.",
      confirmLabel: next ? "Place hold" : "Release hold",
      destructive: !next,
      consequence: next
        ? "This event will be preserved indefinitely."
        : "This event may be purged by the retention job.",
    });
    if (!ok) return;
    try {
      await override.mutateAsync({ auditId: row.id, legalHold: next });
      setLocalHold(next);
      toast({
        kind: "success",
        message: next ? "Legal hold placed." : "Legal hold released.",
      });
    } catch {
      toast({
        kind: "error",
        message:
          "The hold change did not reach the server, so nothing changed. Check your connection and try again.",
      });
    }
  };

  const extend = async (presetDays: number, label: string) => {
    const ok = await confirm({
      title: `Keep this event for ${label}?`,
      message:
        "Sets a per-event retention override. The workspace policy keeps applying to every other event.",
      confirmLabel: `Keep ${label}`,
    });
    if (!ok) return;
    try {
      await override.mutateAsync({
        auditId: row.id,
        retentionOverrideDays: presetDays,
      });
      setLocalDays(presetDays);
      toast({
        kind: "success",
        message: `Retention override set: ${label}.`,
      });
    } catch {
      toast({
        kind: "error",
        message:
          "The override did not reach the server, so nothing changed. Check your connection and try again.",
      });
    }
  };

  return (
    <View style={{ gap: 6 }}>
      <GovernanceNote
        text={
          hold
            ? "Under legal hold — retention rules do not apply to this event."
            : days !== null
              ? `Retention override: ${plural(days, "day")}.`
              : "No per-event retention override. The workspace policy applies."
        }
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <AuditAction
          label={
            override.isPending
              ? "Working…"
              : hold
                ? "Release legal hold"
                : "Place legal hold"
          }
          hint={
            hold
              ? "Lets retention rules apply to this event again"
              : "Preserves this event past every retention rule"
          }
          emphasis={!hold}
          disabled={override.isPending}
          onPress={() => void flipHold()}
        />
        {RETENTION_OVERRIDE_PRESETS.map((preset) => (
          <AuditAction
            key={preset.days}
            label={`Keep ${preset.label}`}
            hint={`Sets this event's retention override to ${preset.label}`}
            disabled={override.isPending || days === preset.days}
            onPress={() => void extend(preset.days, preset.label)}
          />
        ))}
      </View>
    </View>
  );
}

function GovernanceNote({
  text,
  tone,
}: {
  text: string;
  tone?: "warning";
}) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: tone === "warning" ? t.warning : t.fgMuted,
        fontFamily: FONT.regular,
        ...typeStyle("bodySmall"),
      }}
    >
      {text}
    </Text>
  );
}
