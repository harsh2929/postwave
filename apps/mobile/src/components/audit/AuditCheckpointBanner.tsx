/**
 * AuditCheckpointBanner — the tamper-evidence claim, stated.
 *
 * The backend maintains a Merkle-anchored append-only log; that anchoring is
 * the entire difference between an audit log and a table of strings. It was
 * computed, exposed at /api/v1/audit/checkpoint/latest, and never rendered
 * on this client — so the strongest thing the product can say about its own
 * integrity was invisible exactly where someone reads the log under
 * pressure.
 *
 * Deliberately quiet: one line, no colour-only signal, and nothing at all
 * before the first anchor exists (a 404 `no_checkpoint` is a normal answer,
 * not an error, and an "unverified" scare banner on a new workspace would be
 * misleading rather than informative).
 */
import { Text, View } from "react-native";

import type { AuditCheckpoint } from "@/hooks/useAudit";
import { num, relativeTime, truncateMiddle } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditCheckpointBannerProps {
  checkpoint: AuditCheckpoint | null;
  loading?: boolean;
}

/** The sentence the banner speaks, or null when there is nothing to claim. */
export function checkpointSummary(
  checkpoint: AuditCheckpoint | null,
  now = Date.now(),
): string | null {
  if (!checkpoint) return null;
  const size = checkpoint.tree_size;
  const anchored = checkpoint.anchored_at;
  if (typeof size !== "number" && !anchored) return null;
  const parts: string[] = [];
  if (typeof size === "number") {
    parts.push(`${num(size)} events sealed`);
  }
  if (anchored) {
    parts.push(`anchored ${relativeTime(anchored, { now, fallback: "" })}`.trim());
  }
  return parts.filter(Boolean).join(" · ");
}

export function AuditCheckpointBanner({
  checkpoint,
  loading,
}: AuditCheckpointBannerProps) {
  const { t } = useTheme();
  if (loading) return null;
  const summary = checkpointSummary(checkpoint);
  if (!summary || !checkpoint) return null;
  const root = checkpoint.root_hash
    ? truncateMiddle(checkpoint.root_hash, 20)
    : null;

  return (
    <View
      accessible
      accessibilityLabel={`Tamper-evident. ${summary}.${
        root ? ` Merkle root ${root}.` : ""
      }`}
      style={{
        backgroundColor: t.bgSubtle,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 2,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fg,
          fontWeight: "700",
          fontFamily: FONT.bold,
          ...typeStyle("label"),
        }}
      >
        Tamper-evident log
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
      >
        {summary}
      </Text>
      {root ? (
        <Text
          selectable
          {...typeCap("mono")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
            ...typeStyle("mono"),
          }}
        >
          {`root ${root}`}
        </Text>
      ) : null}
    </View>
  );
}
