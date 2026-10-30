/**
 * AuditRowForensics — the press-driven forensic reads under an audit event:
 * "Why this risk?", the Merkle inclusion proof, the linked session replay,
 * and the jump into the request chain.
 *
 * Split out of AuditRowDetail so that sheet stays readable and under the
 * source budget; the write-side (unmask, retention hold) lives in
 * AuditRowGovernance for the same reason.
 *
 * Every lookup here fires ON PRESS, never on open: three extra requests per
 * opened row would be waste on the rows nobody interrogates, and the answers
 * (proof, replay) are only wanted once suspicion exists.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";

import type { AuditAnomaly, AuditRow } from "@/hooks/useAudit";
import {
  useAnomalyExplanation,
  useInclusionProof,
  useSessionReplayLookup,
} from "@/hooks/useAuditForensics";
import { correlationIdFromMetadata } from "@/lib/auditForensics";
import { dateTime, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditRowForensicsProps {
  row: AuditRow;
  anomaly: AuditAnomaly | undefined;
  /** Session owner/admin — gates the inclusion-proof mount (ScopeAdmin). */
  isAdmin: boolean;
  /** audit:read_pii (or admin) — gates anomaly detail, replay and the chain. */
  canReadPii: boolean;
  online: boolean;
  /** Open the request-chain sheet seeded with this correlation id. */
  onTrace: (requestId: string) => void;
}

export function AuditRowForensics({
  row,
  anomaly,
  isAdmin,
  canReadPii,
  online,
  onTrace,
}: AuditRowForensicsProps) {
  const correlationId = correlationIdFromMetadata(row.metadata);
  const showRisk = Boolean(anomaly) && canReadPii;
  const showProof = isAdmin;
  const showReplay = canReadPii && Boolean(row.sessionId);
  const showTrace = canReadPii && Boolean(correlationId);
  if (!showRisk && !showProof && !showReplay && !showTrace) return null;
  return (
    <View style={{ gap: 10 }}>
      {showRisk ? <RiskExplanation auditId={row.id} online={online} /> : null}
      {showProof ? <ProofRow auditId={row.id} online={online} /> : null}
      {showReplay ? <ReplayRow auditId={row.id} online={online} /> : null}
      {showTrace && correlationId ? (
        <ForensicLink
          label="Trace this request"
          hint="Shows every audit row this request wrote, in order"
          onPress={() => onTrace(correlationId)}
        />
      ) : null}
    </View>
  );
}

function RiskExplanation({
  auditId,
  online,
}: {
  auditId: number;
  online: boolean;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const why = useAnomalyExplanation(auditId, open);
  if (!open) {
    return (
      <ForensicLink
        label="Why this risk?"
        hint="Loads the detector reasons behind the risk score"
        disabled={!online}
        onPress={() => setOpen(true)}
      />
    );
  }
  if (why.isLoading) return <ForensicMuted text="Checking the detectors…" />;
  if (why.isError) {
    return (
      <ForensicMuted text="Couldn't load the risk explanation. Pull to refresh and try again." />
    );
  }
  const data = why.data;
  if (!data || !data.available) {
    return (
      <ForensicMuted text="No anomaly assessment exists for this event — the risk pill came from a stale window or a hand flag." />
    );
  }
  return (
    <View
      accessible
      accessibilityLabel={`Risk ${data.bucket}, score ${data.score.toFixed(2)}, ${data.reasons.length} detector reasons`}
      style={{
        backgroundColor: t.bgSubtle,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        gap: 6,
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
        {`Risk ${data.bucket} · score ${data.score.toFixed(2)}`}
      </Text>
      {data.reasons.length === 0 ? (
        <ForensicMuted text="No detector fired — this row may have been hand-flagged." />
      ) : (
        data.reasons.map((r, i) => (
          <Text
            key={`${r.type}-${i}`}
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.regular,
              ...typeStyle("bodySmall"),
            }}
          >
            {`${r.type}${
              r.confidence !== null
                ? ` (${Math.round(r.confidence * 100)}%)`
                : ""
            } — ${r.reason}${r.mitre.length > 0 ? ` · ATT&CK ${r.mitre.join(", ")}` : ""}`}
          </Text>
        ))
      )}
      {data.baseline ? (
        <ForensicMuted text={`Actor baseline: ${data.baseline.join(" · ")}.`} />
      ) : null}
    </View>
  );
}

function ProofRow({ auditId, online }: { auditId: number; online: boolean }) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const proof = useInclusionProof(auditId, open);
  if (!open) {
    return (
      <ForensicLink
        label="Verify tamper evidence"
        hint="Fetches this event's Merkle inclusion proof"
        disabled={!online}
        onPress={() => setOpen(true)}
      />
    );
  }
  if (proof.isLoading) return <ForensicMuted text="Building the proof…" />;
  if (proof.isError) {
    return (
      <ForensicMuted text="Couldn't build the proof. The event may predate the Merkle log for this workspace." />
    );
  }
  const answer = proof.data;
  if (!answer) return null;
  if (answer.kind === "pending") {
    return (
      <ForensicMuted text="Not anchored yet — the signing worker has not rooted this event. Try again in about a minute." />
    );
  }
  return (
    <View
      accessible
      accessibilityLabel={`Inclusion proof: ${answer.pathLength} hashes to a ${answer.signed ? "signed" : "unsigned"} root over ${answer.treeSize} events`}
      style={{ gap: 2 }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.success,
          fontFamily: FONT.semibold,
          ...typeStyle("bodySmall"),
        }}
      >
        {`Provable: ${num(answer.pathLength)} hashes chain this event to the ${
          answer.signed ? "signed" : "unsigned"
        } root over ${num(answer.treeSize)} events${
          answer.anchoredAt ? `, anchored ${dateTime(answer.anchoredAt)}` : ""
        }.`}
      </Text>
      <Text
        selectable
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
      >
        {`root ${answer.rootHash}`}
      </Text>
    </View>
  );
}

function ReplayRow({ auditId, online }: { auditId: number; online: boolean }) {
  const [open, setOpen] = useState(false);
  const replay = useSessionReplayLookup(auditId, open);
  if (!open) {
    return (
      <ForensicLink
        label="Find session replay"
        hint="Looks up the recording that covers this event"
        disabled={!online}
        onPress={() => setOpen(true)}
      />
    );
  }
  if (replay.isLoading) return <ForensicMuted text="Looking for a recording…" />;
  if (replay.isError) {
    return <ForensicMuted text="Couldn't check for a session replay." />;
  }
  const answer = replay.data;
  if (!answer || !answer.available) {
    return (
      <ForensicMuted text="No session replay covers this event — the session was not recorded, or no replay provider is configured." />
    );
  }
  return (
    <ForensicLink
      label={`Watch session replay${answer.provider ? ` (${answer.provider})` : ""}`}
      hint="Opens the recording in the browser, seeked to this event"
      onPress={() => {
        void WebBrowser.openBrowserAsync(answer.replayUrl).catch(() => {
          /* the browser sheet was dismissed — not a failure to report */
        });
      }}
    />
  );
}

function ForensicLink({
  label,
  hint,
  disabled,
  onPress,
}: {
  label: string;
  hint: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled ?? false}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={8}
      style={{ minHeight: 44, justifyContent: "center" }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: disabled ? t.fgSubtle : t.accent,
          fontFamily: FONT.semibold,
          ...typeStyle("control"),
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ForensicMuted({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        fontFamily: FONT.regular,
        ...typeStyle("bodySmall"),
      }}
    >
      {text}
    </Text>
  );
}
