/**
 * AudienceSyncExclusionSection — "who would this sync withhold, and can I prove
 * it", inside the detail sheet.
 *
 * TWO CONTROLS, DELIBERATELY DIFFERENT SHAPES.
 *
 *  - The PREVIEW is press-driven: answering it walks the whole source audience
 *    server-side and runs every member through the consent firewall, so it is a
 *    question a reader asks rather than a cost every sheet-open pays. It is a
 *    FORECAST for the next run and the copy says so — the run rows above it are
 *    the history.
 *  - The RECEIPT is a per-RUN download, not a per-sync one: the route is
 *    `/audience-sync-runs/{run_id}/exclusion-receipt`. It is offered for the
 *    newest run that actually withheld somebody, and the button names that run
 *    so nobody files the wrong one as evidence. It is admin-gated because the
 *    rows carry subscriber emails (`RequireScope(ScopeAdmin)`), and it goes out
 *    through the native share sheet — bounded and re-emitted first, since a CSV
 *    handed to a spreadsheet is an injection surface.
 *
 * A COMPONENT RATHER THAN MORE LINES IN THE SHEET: it owns a press-driven query,
 * a download, a share sheet and a role floor, and the sheet stays a
 * presentational surface that takes its data as props.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Pressable, Share, Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import { fetchSyncExclusionReceiptCsv } from "@/api/audienceSyncExclusions";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useSyncExclusionPreview } from "@/hooks/useAudienceSyncExclusions";
import {
  exclusionPreviewErrorMessage,
  exclusionPreviewLines,
  exclusionReceiptErrorMessage,
  exclusionReceiptShare,
  receiptRunForHistory,
} from "@/lib/audienceSyncExclusions";
import type { AudienceSync, AudienceSyncRun } from "@/lib/audienceSyncs";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export interface AudienceSyncExclusionSectionProps {
  sync: AudienceSync;
  /** The run history the sheet already holds — the receipt is per run. */
  runs: readonly AudienceSyncRun[];
  online: boolean;
}

export function AudienceSyncExclusionSection(
  props: AudienceSyncExclusionSectionProps,
) {
  const { toast } = useToast();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const [requested, setRequested] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const preview = useSyncExclusionPreview(props.sync.id, requested);
  const receiptRun = receiptRunForHistory(props.runs);
  const mayDownload = canAccessMinimumRole("admin", gate.effectiveRole, mode);

  const download = async () => {
    if (!receiptRun || downloading) return;
    setDownloading(true);
    try {
      const csv = await fetchSyncExclusionReceiptCsv(receiptRun.id);
      const share = exclusionReceiptShare(csv, { syncName: props.sync.name });
      if (share.included === 0) {
        toast({
          kind: "info",
          message:
            "That run's receipt came back empty, so there is nothing to share.",
        });
        return;
      }
      haptics.tap();
      await Share.share({ message: share.body, title: share.title });
      if (share.truncated) {
        toast({
          kind: "warning",
          message: `Shared the first ${share.included} withheld records — the full receipt is on the web export.`,
        });
      }
    } catch (error) {
      haptics.error();
      toast({ kind: "error", message: exclusionReceiptErrorMessage(error) });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <View style={{ gap: 8 }}>
      {requested ? (
        <PreviewBody
          lines={preview.data ? exclusionPreviewLines(preview.data) : []}
          loading={preview.isLoading || preview.isFetching === true}
          {...(preview.isError
            ? { error: exclusionPreviewErrorMessage(preview.error) }
            : {})}
        />
      ) : (
        <ActionButton
          label="Preview who would be withheld"
          hint="Runs the consent firewall over this sync's audience without sending anything"
          disabled={!props.online}
          onPress={() => setRequested(true)}
        />
      )}

      {!props.online && !requested ? (
        <Caption>
          You&apos;re offline, so the firewall cannot be asked. Reconnect to run
          the preview.
        </Caption>
      ) : null}

      {receiptRun ? (
        mayDownload ? (
          <ActionButton
            label={
              downloading ? "Preparing receipt…" : "Share the exclusion receipt"
            }
            hint="Downloads the withheld records from the most recent run that withheld anyone"
            disabled={downloading || !props.online}
            onPress={() => void download()}
          />
        ) : (
          <Caption>
            The exclusion receipt lists subscriber emails, so downloading it
            needs an admin role on this workspace.
          </Caption>
        )
      ) : (
        <Caption>
          No recorded run has withheld anyone yet, so there is no receipt to
          share.
        </Caption>
      )}
    </View>
  );
}

function PreviewBody({
  lines,
  loading,
  error,
}: {
  lines: readonly string[];
  loading: boolean;
  error?: string;
}) {
  const { t } = useTheme();
  if (error !== undefined) return <Caption tone="danger">{error}</Caption>;
  if (loading && lines.length === 0) {
    return <Caption>Asking the consent firewall…</Caption>;
  }
  return (
    <View style={{ gap: 4 }}>
      {lines.map((line) => (
        <Text
          key={line}
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}

function Caption({
  children,
  tone,
}: {
  children: string;
  tone?: "danger";
}) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: tone === "danger" ? t.danger : t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

function ActionButton({
  label,
  hint,
  disabled,
  onPress,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      style={{
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 12,
        backgroundColor: t.surface,
        borderWidth: 1,
        borderColor: t.borderSubtle,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: disabled ? t.fgSubtle : t.accent,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
