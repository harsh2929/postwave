/**
 * ProductEventSamplePanel — the newest raw rows for one event name.
 *
 * WHY A DRILL-DOWN AT ALL. The catalogue answers "is it still arriving". The
 * question immediately after that is "and is it arriving with the right
 * payload" — the deploy shipped an hour ago, the event count is climbing, and
 * every row is missing `order_id`. That is answerable from a phone and it is
 * the reason the panel shows PROPERTY KEYS rather than a prose summary.
 *
 * KEYS, NOT VALUES. `Properties` is an untyped `map[string]interface{}`
 * (track/repo.go:35): arbitrary customer data, frequently including email
 * addresses and order values. Painting it into a 390pt list would be both
 * unreadable and a needless PII spill onto a lock screen. The keys are the part
 * that answers the schema question; the whole row is one tap away on the
 * clipboard for anyone who needs the values.
 *
 * A PAGE IS A SAMPLE. `ListEvents` returns `{"items": …}` with no cursor and no
 * total (track/handlers.go:312), so the only honest sentence is "the newest N",
 * and when the page comes back full it says the rest are on the web admin.
 *
 * THE 403 HERE IS NOT THE 403 UPSTAIRS. This route is
 * `RequireAllScopes(ScopeReadReports, ScopeReadSubscribers)` (handlers.go:92)
 * while the catalogue needs only the first, so an API-key session can
 * legitimately read the whole catalogue and be refused this one panel. It says
 * which permission is missing instead of rendering "no events".
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { PRODUCT_EVENT_SAMPLE_LIMIT } from "@/api/productEvents";
import { dateTime, plural, relativeTime, truncateMiddle } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { copyToClipboard } from "@/lib/clipboard";
import { shownEventText } from "@/lib/productEvents";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { ProductEventLine, ProductEventSample } from "@/lib/productEvents";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function scopeDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 403
  );
}

export interface ProductEventSamplePanelProps {
  eventName: string;
  sample: QueryLike & { data?: ProductEventSample | undefined };
  gate: Pick<OnlineQueryGate, "enabled">;
}

export function ProductEventSamplePanel({
  eventName,
  sample,
  gate,
}: ProductEventSamplePanelProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const rows = Array.isArray(sample.data?.items) ? sample.data?.items : [];
  const requested = sample.data?.requested ?? PRODUCT_EVENT_SAMPLE_LIMIT;
  const full = rows.length >= requested && requested > 0;

  const onCopy = async (line: ProductEventLine) => {
    haptics.tap();
    const copied = await copyToClipboard(shownEventText(line));
    // `copyToClipboard` resolves false on a locked pasteboard rather than
    // throwing, and a toast that says "Copied" when nothing was is worse than
    // one that admits it.
    toast(
      copied
        ? { kind: "success", message: "Event copied — property values withheld, as shown." }
        : { kind: "error", message: "The clipboard refused the copy." },
    );
  };

  if (scopeDenied(sample.error)) {
    return (
      <PanelShell>
        <Text
          accessibilityRole="alert"
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          Reading individual events needs subscriber-read permission as well as
          report-read. The catalogue above still works; the rows don&apos;t.
        </Text>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      <QueryStates
        query={sample}
        gate={gate}
        isEmpty={rows.length === 0}
        offlineMessage="Reconnect to read the newest events for this name."
        skeleton={<SkeletonList rows={3} lines={2} label="Loading recent events" />}
        empty={{
          title: "Nothing in the last page",
          description: `The catalogue counted ${eventName} inside the window, but this read returned no rows — the newest ones may have arrived under a different name.`,
        }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            paddingBottom: 2,
          }}
        >
          {`The ${plural(rows.length, "newest event")}${
            full ? " — older ones are on the web admin" : ""
          }`}
        </Text>
        {rows.map((line) => (
          <SampleRow key={line.id} line={line} onCopy={onCopy} />
        ))}
      </QueryStates>
    </PanelShell>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.bgSubtle,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginBottom: 12,
        gap: 4,
      }}
    >
      {children}
    </View>
  );
}

function SampleRow({
  line,
  onCopy,
}: {
  line: ProductEventLine;
  onCopy: (line: ProductEventLine) => void;
}) {
  const { t } = useTheme();
  const abs = dateTime(line.occurredAt, "");
  // The DEVICE clock, unlike every age in the catalogue above. `ListEvents`
  // returns `{"items": …}` with no measurement instant (track/handlers.go:312),
  // so there is no server snapshot to anchor to — which is exactly why the
  // absolute timestamp travels in the accessibility label rather than only the
  // relative one.
  const rel = relativeTime(line.occurredAt, { fallback: "" });
  const keys = line.propertyKeys;
  const keyText = keys.length
    ? keys.join(" · ")
    : "no properties on this event";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Event ${line.id}${
        abs ? `, ${abs}` : ", no timestamp recorded"
      }. ${
        keys.length
          ? `${plural(keys.length, "property", "properties")}: ${keys.join(", ")}.`
          : "No properties."
      }`}
      accessibilityHint="Copies the full event JSON"
      onPress={() => onCopy(line)}
      // Static object — NativeWind v4 drops layout from a function style.
      style={{
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
        minHeight: 44,
        justifyContent: "center",
        gap: 2,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        numberOfLines={1}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {rel || "time not reported"}
        {line.subscriberId
          ? ` · ${truncateMiddle(line.subscriberId, 14)}`
          : " · no subscriber linked"}
      </Text>
      <Text
        {...typeCap("mono")}
        numberOfLines={2}
        style={{
          color: t.fgMuted,
          ...typeStyle("mono"),
        }}
      >
        {keyText}
      </Text>
    </Pressable>
  );
}
