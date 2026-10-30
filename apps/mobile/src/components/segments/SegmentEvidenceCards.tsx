/**
 * SegmentEvidenceCards — the four evidence panels desktop keeps on the
 * segment slideover (SegmentSnapshotsSection / definition history / usage /
 * SegmentGrowthReport), translated to collapsed mobile cards.
 *
 * Every panel is COLLAPSED by default and its query fires only once opened
 * (the hooks take `open`), so visiting a segment costs the two reads the
 * screen always needed and not six.
 *
 * The one write — POST /segments/{id}/snapshot — is editor-floor and
 * PRESS-DRIVEN: a snapshot is evidence of "the segment as of NOW", so it is
 * never taken on the operator's behalf. Below editor the button is omitted
 * (not disabled); the read-only history renders for every role.
 *
 * The growth report renders the server's own `note` verbatim — it is the
 * server's honesty sentence about sparse snapshot coverage, not ours.
 */
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import { useToast } from "@/components/Toast";
import {
  useCreateSegmentSnapshot,
  useSegmentDefinitionHistory,
  useSegmentGrowthReport,
  useSegmentSnapshots,
  useSegmentUsage,
} from "@/hooks/useSegmentAdvanced";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { plural, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { segmentUsageKindLabel } from "@/lib/segmentAdvancedRows";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const ROWS_SHOWN = 20;

function Panel({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { t } = useTheme();
  return (
    <Card accessibilityLabel={title}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Label>{title}</Label>
        <Text
          allowFontScaling={false}
          style={{ color: t.fgSubtle, fontFamily: FONT.regular }}
        >
          {open ? "▾" : "▸"}
        </Text>
      </Pressable>
      {open ? children : null}
    </Card>
  );
}

function Line({ muted, children }: { muted?: boolean; children: ReactNode }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: muted ? t.fgMuted : t.fg,
        ...typeStyle("label"),
        fontFamily: muted ? FONT.regular : FONT.medium,
        marginTop: 6,
      }}
    >
      {children}
    </Text>
  );
}

function PanelBody({
  isLoading,
  isError,
  error,
  onRetry,
  empty,
  rows,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  empty: string;
  rows: { key: string; primary: string; secondary: string }[];
}) {
  const { t } = useTheme();
  if (isError) return <ErrorState compact error={error} onRetry={onRetry} />;
  if (isLoading) return <Line muted>Loading…</Line>;
  if (rows.length === 0) return <Line muted>{empty}</Line>;
  return (
    <View>
      {rows.slice(0, ROWS_SHOWN).map((row, i) => (
        <View
          key={row.key}
          style={{
            paddingVertical: 8,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: t.border,
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.fg,
              ...typeStyle("label"),
              fontFamily: FONT.medium,
            }}
            numberOfLines={1}
          >
            {row.primary}
          </Text>
          {row.secondary ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
              numberOfLines={1}
            >
              {row.secondary}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function SnapshotsPanel({ segmentId, open }: { segmentId: string; open: boolean }) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const snapshots = useSegmentSnapshots(segmentId, open);
  const take = useCreateSegmentSnapshot(segmentId);
  const canSnapshot = canAccessMinimumRole("editor", gate.effectiveRole);

  const onTake = () => {
    if (take.isPending) return;
    haptics.tap();
    take.mutate(undefined, {
      onSuccess: () => {
        haptics.success();
        toast({ kind: "success", message: "Snapshot recorded." });
      },
      onError: (error) => {
        haptics.error();
        toast({
          kind: "error",
          message:
            errorPresentation(error).message || "Couldn't take a snapshot.",
        });
      },
    });
  };

  return (
    <>
      <Line muted>
        Point-in-time membership counts — evidence of what the segment
        actually was.
      </Line>
      <PanelBody
        isLoading={snapshots.isLoading}
        isError={snapshots.isError}
        error={snapshots.error}
        onRetry={() => void snapshots.refetch()}
        empty="No snapshots recorded yet."
        rows={(Array.isArray(snapshots.data) ? snapshots.data : []).map((s) => ({
          key: s.id,
          primary: plural(s.count, "member"),
          secondary: `${relativeTime(s.evaluatedAt, { fallback: s.evaluatedAt })}${
            s.evaluatorVersion ? ` · evaluator ${s.evaluatorVersion}` : ""
          }`,
        }))}
      />
      {canSnapshot ? (
        <Pressable
          onPress={onTake}
          disabled={take.isPending}
          accessibilityRole="button"
          accessibilityLabel="Take a snapshot now"
          accessibilityState={{ disabled: take.isPending }}
          style={{ paddingVertical: 10 }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.accent,
              ...typeStyle("label"),
              fontFamily: FONT.medium,
            }}
          >
            {take.isPending ? "Recording…" : "Take a snapshot now"}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
}

function GrowthPanel({ segmentId, open }: { segmentId: string; open: boolean }) {
  const report = useSegmentGrowthReport(segmentId, open);
  const data = report.data;
  if (report.isError) {
    return (
      <ErrorState
        compact
        error={report.error}
        onRetry={() => void report.refetch()}
      />
    );
  }
  if (!data) return <Line muted>Loading…</Line>;
  const sign = data.netDelta > 0 ? "+" : "";
  return (
    <>
      <Line>
        {`${sign}${data.netDelta} net over ${plural(data.days, "day")} — ${data.totalAdds} added, ${data.totalDrops} dropped`}
      </Line>
      {data.anomalyCount > 0 ? (
        <Line>{plural(data.anomalyCount, "anomalous day")}</Line>
      ) : null}
      {data.note ? <Line muted>{data.note}</Line> : null}
    </>
  );
}

export function SegmentEvidenceCards({ segmentId }: { segmentId: string }) {
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  const toggle = (key: string) =>
    setOpenPanel((current) => (current === key ? null : key));

  const historyOpen = openPanel === "history";
  const usageOpen = openPanel === "usage";
  const history = useSegmentDefinitionHistory(segmentId, historyOpen);
  const usage = useSegmentUsage(segmentId, usageOpen);

  return (
    <>
      <Panel
        title="Snapshots"
        open={openPanel === "snapshots"}
        onToggle={() => toggle("snapshots")}
      >
        <SnapshotsPanel segmentId={segmentId} open={openPanel === "snapshots"} />
      </Panel>

      <Panel
        title="Definition history"
        open={historyOpen}
        onToggle={() => toggle("history")}
      >
        <PanelBody
          isLoading={history.isLoading}
          isError={history.isError}
          error={history.error}
          onRetry={() => void history.refetch()}
          empty="No definition changes recorded."
          rows={(Array.isArray(history.data) ? history.data : []).map((row, i) => ({
            key: row.auditId || `${row.at}-${i}`,
            primary: row.action || "changed",
            secondary: `${row.actorLabel}${row.actorLabel ? " · " : ""}${relativeTime(row.at, { fallback: row.at })}`,
          }))}
        />
      </Panel>

      <Panel
        title="Used by"
        open={usageOpen}
        onToggle={() => toggle("usage")}
      >
        <PanelBody
          isLoading={usage.isLoading}
          isError={usage.isError}
          error={usage.error}
          onRetry={() => void usage.refetch()}
          empty="No campaigns, captures, or syncs target this segment."
          rows={(Array.isArray(usage.data) ? usage.data : []).map((row) => ({
            key: `${row.kind}-${row.id}`,
            primary: row.name,
            secondary: `${segmentUsageKindLabel(row.kind)}${row.status ? ` · ${row.status}` : ""}`,
          }))}
        />
      </Panel>

      <Panel
        title="Growth report"
        open={openPanel === "growth"}
        onToggle={() => toggle("growth")}
      >
        <GrowthPanel segmentId={segmentId} open={openPanel === "growth"} />
      </Panel>
    </>
  );
}
