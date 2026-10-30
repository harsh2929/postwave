/**
 * AuditSheetParts — the pieces the audit detail sheet is made of.
 *
 * Split out of AuditRowDetail so neither file grows past the point where it
 * can be read in one sitting, and so the label/value row and the diff block
 * can be reused by any future audit surface (an investigation view, an
 * alert-rule preview) without lifting the whole modal.
 */
import { Pressable, Text, View, useWindowDimensions } from "react-native";

import type { AuditMetadataView } from "@/lib/auditDiff";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { TYPE, typeCap, typeStyle } from "@/lib/typeScale";
import { transitionLabel } from "@/lib/direction";

/**
 * Width of the fixed label column in an `AuditFactRow`, derived rather than
 * literal.
 *
 * A hardcoded `width: 78` is correct at exactly one OS text size: raise the
 * setting and "Retention" wraps to three lines inside a box that cannot grow,
 * while the value beside it keeps its full width. Growing the column with the
 * device font scale — bounded by the `label` role's own ceiling, so the value
 * column is never squeezed out — keeps the two columns in proportion.
 *
 * Exported for the colocated test; `fontScale` is `unknown` because
 * `useWindowDimensions()` can report a partially-populated object on the first
 * frame, exactly as `maxLinesAtScale` documents.
 */
export function factLabelWidth(fontScale: unknown): number {
  const base = 78;
  const raw =
    typeof fontScale === "number" && Number.isFinite(fontScale) && fontScale > 1
      ? fontScale
      : 1;
  const effective = Math.min(raw, TYPE.label.maxFontSizeMultiplier);
  return Math.round(base * effective);
}

export function SheetHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 8,
        borderBottomColor: t.borderSubtle,
        borderBottomWidth: 1,
      }}
    >
      <Text
        {...typeCap("title")}
        style={{
          color: t.fg,
          fontWeight: "700",
          fontFamily: FONT.bold,
          ...typeStyle("title"),
        }}
      >
        {title}
      </Text>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
        hitSlop={12}
        style={{
          minHeight: 44,
          minWidth: 44,
          alignItems: "flex-end",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accent,
            fontWeight: "600",
            fontFamily: FONT.semibold,
            ...typeStyle("callout"),
          }}
        >
          Done
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * One label/value fact. `selectable` is set on identifiers (ids, IPs, user
 * agents) so they can be long-pressed and copied — the only way to get a
 * correlation id off a phone and into an incident channel.
 */
export function AuditFactRow({
  label,
  value,
  selectable,
}: {
  label: string;
  value: string;
  selectable?: boolean;
}) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{ flexDirection: "row", gap: 10, paddingVertical: 5 }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          // The label column was a literal 78. A fixed width holding text is
          // only correct at one text size, so it is derived from the role and
          // the device font scale (bounded by the role's own ceiling) — the
          // same rule `tabBarHeightFor` applies to the tab bar.
          width: factLabelWidth(fontScale),
          ...typeStyle("label"),
        }}
      >
        {label}
      </Text>
      <Text
        selectable={selectable ?? false}
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          flex: 1,
          fontFamily: FONT.regular,
          ...typeStyle("bodySmall"),
        }}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * The metadata readout: a leaf diff when the emitter carried a before/after
 * pair, otherwise the flattened raw blob. Both are capped by auditDiff, and
 * the cap is disclosed rather than silently swallowed — a truncated diff
 * that looks complete is worse than no diff.
 */
export function AuditMetadataBlock({ view }: { view: AuditMetadataView }) {
  const { t } = useTheme();
  const isEmpty =
    view.diff.length === 0 &&
    view.entries.length === 0 &&
    view.truncatedRows === 0 &&
    view.truncatedEntries === 0;
  if (isEmpty) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("bodySmall"),
        }}
      >
        This event carried no metadata.
      </Text>
    );
  }
  const truncated = view.hasPair ? view.truncatedRows : view.truncatedEntries;
  return (
    <View style={{ gap: 8 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          fontWeight: "700",
          fontFamily: FONT.bold,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          ...typeStyle("caption"),
        }}
      >
        {view.hasPair ? "What changed" : "Details"}
      </Text>
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 12,
          padding: 12,
          gap: 8,
        }}
      >
        {view.hasPair
          ? view.diff.map((d) => (
              <View key={d.key} accessible accessibilityLabel={spokenDiff(d)}>
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgMuted,
                    fontFamily: FONT.regular,
                    ...typeStyle("caption"),
                  }}
                >
                  {d.key}
                </Text>
                <Text
                  selectable
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fg,
                    fontFamily: FONT.regular,
                    ...typeStyle("bodySmall"),
                  }}
                >
                  {diffLine(d)}
                </Text>
              </View>
            ))
          : view.entries.map((e) => (
              <View
                key={e.key}
                accessible
                accessibilityLabel={`${e.key}: ${e.value}`}
              >
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgMuted,
                    fontFamily: FONT.regular,
                    ...typeStyle("caption"),
                  }}
                >
                  {e.key}
                </Text>
                <Text
                  selectable
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fg,
                    fontFamily: FONT.regular,
                    ...typeStyle("bodySmall"),
                  }}
                >
                  {e.value}
                </Text>
              </View>
            ))}
        {truncated > 0 ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
            }}
          >
            {`${truncated} more not shown — open this event in the web admin for the full payload.`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function diffLine(d: AuditMetadataView["diff"][number]): string {
  if (d.kind === "added") return `+ ${d.after}`;
  if (d.kind === "removed") return `− ${d.before}`;
  return transitionLabel(d.before, d.after);
}

function spokenDiff(d: AuditMetadataView["diff"][number]): string {
  if (d.kind === "added") return `${d.key} added, now ${d.after}`;
  if (d.kind === "removed") return `${d.key} removed, was ${d.before}`;
  return `${d.key} changed from ${d.before} to ${d.after}`;
}
