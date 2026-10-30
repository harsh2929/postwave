/**
 * HelpdeskStatusChips — the conversation-status vocabulary as a control.
 *
 * THE LIST IS THE SERVER'S, NOT OURS. `conversation_statuses` comes from
 * `GET /api/v1/service-suite/catalog`, and `SetConversationStatus` validates
 * against the same set (`allowed(in.Status, statuses())`). Hardcoding it here
 * would let a build ship an option that 400s, so when the catalog has not
 * loaded there are NO chips — an absent control is honest, an invented one is
 * not.
 *
 * Seven statuses do not fit a segmented control at any accessible text size,
 * so this is a horizontally scrolling chip row: each chip keeps its own 44pt
 * target and grows with the OS font instead of truncating.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, ScrollView, Text } from "react-native";

import { humanizeToken } from "@/lib/helpdesk";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface HelpdeskStatusChipsProps {
  /** From the catalog. Empty renders nothing at all. */
  statuses: readonly string[];
  /** The selected status, or null for the "All" chip. */
  value: string | null;
  onSelect: (status: string | null) => void;
  /** Prepend an "All" chip. Filters have one; a status CHANGE does not. */
  includeAll?: boolean;
  disabled?: boolean;
  /** Which of the two jobs this row is doing, for the screen reader. */
  accessibilityLabel: string;
  /** Verb used in each chip's spoken label — "Show" or "Set to". */
  actionVerb: string;
  /** The status currently being written, so its chip can say so. */
  pendingStatus?: string | null;
}

export function HelpdeskStatusChips(props: HelpdeskStatusChipsProps) {
  const { t } = useTheme();
  if (props.statuses.length === 0) return null;

  const entries: { key: string; value: string | null; label: string }[] = [
    ...(props.includeAll
      ? [{ key: "__all__", value: null, label: "All" }]
      : []),
    ...props.statuses.map((status) => ({
      key: status,
      value: status,
      label: humanizeToken(status),
    })),
  ];

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel={props.accessibilityLabel}
      contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
    >
      {entries.map((entry) => {
        const selected = entry.value === props.value;
        const busy =
          props.pendingStatus != null && props.pendingStatus === entry.value;
        return (
          <Pressable
            key={entry.key}
            onPress={() => {
              if (props.disabled) return;
              haptics.tap();
              props.onSelect(entry.value);
            }}
            disabled={props.disabled}
            accessibilityRole="button"
            accessibilityLabel={`${props.actionVerb} ${entry.label}`}
            accessibilityState={{
              selected,
              disabled: Boolean(props.disabled),
              busy,
            }}
            style={{
              minHeight: 44,
              justifyContent: "center",
              paddingHorizontal: 14,
              borderRadius: 20,
              borderWidth: 1,
              borderColor: selected ? t.accent : t.border,
              backgroundColor: selected ? t.accentSubtle : t.surface,
              opacity: props.disabled ? 0.5 : 1,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: selected ? t.accent : t.fgMuted,
                ...typeStyle("control"),
                fontFamily: selected ? FONT.semibold : FONT.medium,
              }}
              numberOfLines={1}
            >
              {busy ? `${entry.label}…` : entry.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
