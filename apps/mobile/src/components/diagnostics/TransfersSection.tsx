/**
 * TransfersSection — every export, import and share in one card (parity
 * register, shell-crosscutting "unified transfer center"; desktop anchor
 * components/TransferCenter.tsx).
 *
 * What a phone can honestly offer per row, from hooks/useTransferCenter:
 *   cancel  — a running subscriber import the caller may cancel;
 *   retry   — a failed/expired workspace export (admin, online), or a share
 *             from this session whose sheet failed to open;
 *   open    — a ready workspace bundle's signed URL (desktop's "reveal in
 *             Finder" is the OS share/open here).
 * "Clear history" hides finished rows for this session; the server's own
 * lists are never touched — a phone should not edit a workspace-wide history.
 *
 * The subtitle never calls an empty list healthy: it proves only that
 * nothing was recorded.
 *
 * NativeWind v4 gotcha: STATIC Pressable styles only.
 */
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { SectionLabel } from "@/components/SectionLabel";
import { useToast } from "@/components/Toast";
import { useTransferCenter } from "@/hooks/useTransferCenter";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import type { TransferPhase, TransferRow } from "@/lib/transferCenter";
import { typeCap, typeStyle } from "@/lib/typeScale";

const PHASE_LABEL: Record<TransferPhase, string> = {
  active: "In progress",
  waiting: "Queued",
  stalled: "Stalled",
  done: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
};

export const TRANSFERS_EMPTY_NOTE =
  "Workspace exports, audit exports, subscriber imports and this phone's share-sheet hand-offs appear here.";

export function TransfersSection() {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const center = useTransferCenter();

  const onAction = async (row: TransferRow, action: TransferRow["actions"][number]) => {
    haptics.tap();
    if (action === "cancel") {
      const id = row.id.replace(/^subscriber-import:/, "");
      const ok = await confirm({
        title: "Stop this import?",
        message: `${row.label} stops after the current chunk. Rows already imported stay.`,
        confirmLabel: "Stop import",
        destructive: true,
      });
      if (ok) center.cancelImport(id);
      return;
    }
    if (action === "open") {
      if (!row.openUrl || !(await center.open(row.openUrl))) {
        toast({ kind: "error", message: `Couldn't open the download for ${row.label}.` });
      }
      return;
    }
    if (row.source === "local") {
      const ran = await center.retryLocal(row.id);
      if (!ran) toast({ kind: "error", message: "That share can't be retried any more." });
      return;
    }
    const queued = await center.retryExport();
    toast(
      queued
        ? { kind: "success", message: "A new workspace export is queued." }
        : { kind: "error", message: "Couldn't queue a new export." },
    );
  };

  return (
    <Card>
      <SectionLabel topMargin={0} subtitle={center.summary}>
        Transfers
      </SectionLabel>
      {center.notice ? <Note tone="muted">{center.notice}</Note> : null}
      {!center.online ? (
        <Note tone="warning">
          You&apos;re offline — server lists may be stale, and cancel or retry need a connection.
        </Note>
      ) : null}
      {center.error ? (
        <View style={{ gap: 8 }}>
          <Note tone="danger">{center.error}</Note>
          <ActionButton label="Retry reading" onPress={() => void center.refresh()} />
        </View>
      ) : null}
      {center.loading && center.rows.length === 0 ? (
        <Note tone="muted">Reading transfer lists…</Note>
      ) : null}
      {!center.loading && !center.error && center.rows.length === 0 ? (
        <Note tone="muted">{TRANSFERS_EMPTY_NOTE}</Note>
      ) : null}

      {center.rows.map((row) => (
        <View
          key={row.id}
          style={{ paddingVertical: 8, gap: 4 }}
          accessible
          accessibilityLabel={`${row.label}. ${PHASE_LABEL[row.phase]}. ${row.detail}`}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pill label={PHASE_LABEL[row.phase]} tone={row.tone} size="sm" />
            <Text
              {...typeCap("bodySmall")}
              style={{ color: t.fg, ...typeStyle("bodySmall"), flexShrink: 1, fontFamily: FONT.medium }}
            >
              {row.label}
            </Text>
          </View>
          <View
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}
          >
            <Text
              {...typeCap("label")}
              style={{ color: t.fgMuted, ...typeStyle("label"), flexShrink: 1, fontFamily: FONT.regular }}
            >
              {row.detail} · {relativeTime(row.updatedAt)}
            </Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              {row.actions.map((action) => (
                <Pressable
                  key={action}
                  onPress={() => void onAction(row, action)}
                  disabled={center.busy}
                  accessibilityRole="button"
                  accessibilityLabel={`${actionLabel(action)} ${row.label}`}
                  accessibilityState={{ disabled: center.busy }}
                  hitSlop={8}
                  style={{ minHeight: 44, justifyContent: "center" }}
                >
                  <Text
                    {...typeCap("control")}
                    style={{
                      color: action === "cancel" ? t.danger : t.accent,
                      ...typeStyle("control"),
                      fontWeight: "600",
                      fontFamily: FONT.semibold,
                    }}
                  >
                    {actionLabel(action)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>
      ))}

      {center.counts.finished + center.counts.failed > 0 ? (
        <View style={{ marginTop: 12 }}>
          <ActionButton
            label="Clear history"
            onPress={() => {
              haptics.tap();
              center.clearHistory();
            }}
          />
        </View>
      ) : null}
    </Card>
  );
}

function actionLabel(action: TransferRow["actions"][number]): string {
  switch (action) {
    case "cancel":
      return "Stop";
    case "retry":
      return "Retry";
    case "open":
      return "Open";
  }
}

function Note({ tone, children }: { tone: "muted" | "warning" | "danger"; children: string }) {
  const { t } = useTheme();
  const color = tone === "danger" ? t.danger : tone === "warning" ? t.warning : t.fgMuted;
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{ color, ...typeStyle("bodySmall"), marginBottom: 8, fontFamily: FONT.regular }}
    >
      {children}
    </Text>
  );
}

function ActionButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: t.border,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{ color: t.fg, ...typeStyle("control"), fontWeight: "600", fontFamily: FONT.semibold }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
