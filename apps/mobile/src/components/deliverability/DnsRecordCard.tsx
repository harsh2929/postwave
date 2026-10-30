/**
 * DnsRecordCard — one DNS record, readable in full and actually copyable.
 *
 * A DKIM TXT value is typically 400+ characters. The old card rendered it at
 * `numberOfLines={3}` in 11pt Menlo — roughly 100 characters on a 375pt phone —
 * and `selectable` cannot select what is not rendered. The only other route
 * was a button labelled "Copy" that actually opened the SHARE sheet. So on the
 * one screen whose entire job is transporting DNS values, the value was both
 * unreadable and un-copyable.
 *
 * This card:
 *  - COPIES. Each field carries its own Copy control writing that field to the
 *    system pasteboard via `lib/clipboard`. Host and value are separate
 *    controls because a registrar form has two boxes, and a single blob that
 *    fits neither is why the old share sheet was two taps for nothing. The
 *    control reports the clipboard's own answer — `setStringAsync` resolves
 *    `false` on a locked pasteboard, and a control that says "Copied" when
 *    nothing was copied is worse than one that admits the failure.
 *  - expands to the full value on tap, with `ellipsizeMode="middle"` while
 *    collapsed so the selector prefix AND the key tail stay visible;
 *  - carries the complete value in the accessibility label regardless of the
 *    visual truncation;
 *  - keeps Share for the whole record — the one thing a share sheet is
 *    genuinely better at, because it carries host AND value to a laptop.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import { ContextualHintButton } from "@/components/onboarding/ContextualHintButton";
import { copyToClipboard } from "@/lib/clipboard";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
}

export interface DnsRecordCardProps {
  record: DnsRecord;
  domain: string;
  onShare: (record: DnsRecord) => void;
  /**
   * A @postwave/onboarding-schema CONTEXTUAL_HINTS key to render beside the
   * record type — DomainRowCard passes "sending-identity.dkim" for the DKIM
   * record, the one desktop explains and mobile never did.
   */
  hintKey?: string;
}

export function DnsRecordCard({
  record,
  domain,
  onShare,
  hintKey,
}: DnsRecordCardProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);

  const copy = useCallback(
    (field: "host" | "value", text: string) => {
      haptics.tap();
      void copyToClipboard(text).then((ok) => {
        if (ok) {
          haptics.success();
          toast({ kind: "success", message: `${record.type} ${field} copied` });
          return;
        }
        haptics.error();
        toast({
          kind: "error",
          message:
            "Couldn't reach the clipboard. Use Share to send the record instead.",
        });
      });
    },
    [record.type, toast],
  );

  return (
    <View
      style={{
        backgroundColor: t.bgSubtle,
        borderRadius: 8,
        padding: 10,
        marginTop: 6,
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
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.semibold,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {record.type}
        </Text>
        {hintKey ? (
          <View style={{ flex: 1 }}>
            <ContextualHintButton hintKey={hintKey} compact />
          </View>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <RecordAction
          label={"Share \u2934\uFE0E"}
          tone="muted"
          accessibilityLabel={`Share the whole ${record.type} record for ${domain}`}
          onPress={() => {
            haptics.tap();
            onShare(record);
          }}
        />
      </View>

      <FieldRow
        caption="Host"
        text={record.name}
        accessibilityLabel={`Copy the ${record.type} host for ${domain}`}
        onCopy={() => copy("host", record.name)}
        lines={2}
      />

      <FieldRow
        caption="Value"
        text={record.value}
        accessibilityLabel={`Copy the ${record.type} record value for ${domain}`}
        onCopy={() => copy("value", record.value)}
        lines={expanded ? 0 : 3}
      />

      <Pressable
        onPress={() => {
          haptics.tap();
          setExpanded((prev) => !prev);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${record.type} record value for ${domain}: ${record.value}`}
        accessibilityHint={
          expanded ? "Collapses the value" : "Shows the full value"
        }
        accessibilityState={{ expanded }}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("control")}
          importantForAccessibility="no"
          style={{
            color: t.accent,
            ...typeStyle("control"),
            fontFamily: FONT.medium,
          }}
        >
          {expanded ? "Show less" : "Show full value"}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * One labelled field with its own Copy control.
 *
 * The text stays `selectable` so a partial selection is still possible, and
 * the Copy control sits beside it rather than replacing it. `lines === 0`
 * means "no clamp": `numberOfLines={0}` is a clamp of zero on Android, so it
 * is mapped to an omitted prop instead.
 */
function FieldRow({
  caption,
  text,
  accessibilityLabel,
  onCopy,
  lines,
}: {
  caption: string;
  text: string;
  accessibilityLabel: string;
  onCopy: () => void;
  lines: number;
}) {
  const { t } = useTheme();
  return (
    <View style={{ marginTop: 8 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.semibold,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {caption}
        </Text>
        <RecordAction
          label="Copy"
          tone="accent"
          accessibilityLabel={accessibilityLabel}
          onPress={onCopy}
        />
      </View>
      <Text
        selectable
        {...typeCap("mono")}
        style={{
          fontFamily: "Menlo",
          marginTop: 2,
          ...typeStyle("mono"),
          color: t.fg,
        }}
        {...(lines > 0 ? { numberOfLines: lines } : {})}
        ellipsizeMode="middle"
      >
        {text}
      </Text>
    </View>
  );
}

/** A compact text button with a 44pt effective target via hitSlop. */
function RecordAction({
  label,
  tone,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  tone: "accent" | "muted";
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
      style={{ paddingHorizontal: 4, paddingVertical: 4 }}
    >
      <Text
        {...typeCap("control")}
        importantForAccessibility="no"
        style={{
          color: tone === "accent" ? t.accent : t.fgMuted,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
