/**
 * StreamingConnectionSection — one streaming-export connection's shipped
 * windows, inside the streaming sheet.
 *
 * FIVE STATES, EACH SAYING WHAT IS TRUE. Loading, offline-with-nothing-cached,
 * a read the server refused (with the status-specific sentence), an empty
 * history ("no records were returned" — never "nothing is wrong"), and the
 * rows. The read's failure is PER CONNECTION: `loadStreamingExportHistories`
 * settles each id on its own, so this section never inherits a sibling's 404.
 *
 * THE FAILED-WINDOW NOTE is the desktop's sentence verbatim
 * (StreamingExportStatus.tsx:576-579), followed by the honest asymmetry this
 * screen keeps everywhere: the phone can see the failure and cannot ship the
 * retry, because shipping wants the configuration in front of you.
 */
import type { ReactNode } from "react";
import { Text, View } from "react-native";

import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { StreamingRunRow } from "@/components/warehouse/StreamingRunRow";
import { EMDASH, num, plural, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  streamingConnectionVerdict,
  streamingHistoryErrorMessage,
  type StreamingConnectionEntry,
} from "@/lib/streamingExportVerdict";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * Newest windows shown per connection. The handler returns 50; a phone sheet
 * listing 50 cards per connection is a scroll nobody finishes, and the count
 * line below the rows says exactly how many the response held.
 */
export const STREAMING_ROWS_SHOWN = 8;

/** Desktop copy, verbatim (StreamingExportStatus.tsx:576-579). */
const FAILED_WINDOW_NOTE =
  "Failed windows retain their bounded cursor. Shipping again resumes from the last committed cursor and does not advance past unverified events.";

export interface StreamingConnectionSectionProps {
  entry: StreamingConnectionEntry;
  /** The dock's history query has not produced data yet. */
  loading: boolean;
  /** The online gate is closed and nothing is cached. */
  offline: boolean;
}

function Note({ children, tone }: { children: string; tone?: "danger" }) {
  const { t } = useTheme();
  return (
    <Text
      selectable
      {...typeCap("bodySmall")}
      style={{
        color: tone === "danger" ? t.danger : t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
        marginBottom: 8,
      }}
    >
      {children}
    </Text>
  );
}

export function StreamingConnectionSection({
  entry,
  loading,
  offline,
}: StreamingConnectionSectionProps) {
  const { t } = useTheme();
  const history = entry.history;
  const verdict = history ? streamingConnectionVerdict(history) : null;
  const lastShipped = history?.lastShippedAt
    ? `Last caught-up window ${relativeTime(history.lastShippedAt)}.`
    : "";
  const subtitle = verdict
    ? [verdict.headline, lastShipped].filter(Boolean).join(" ")
    : undefined;

  let body: ReactNode;
  if (history) {
    const shown = history.runs.slice(0, STREAMING_ROWS_SHOWN);
    body =
      history.runs.length === 0 ? (
        <Note>
          No shipment records were returned. The scheduled worker creates the
          next due window; shipping one now is a web-admin action.
        </Note>
      ) : (
        <>
          {verdict && verdict.failedWindows > 0 ? (
            <Note>{`${FAILED_WINDOW_NOTE} Shipping again is a web-admin action — this app deliberately does not offer it.`}</Note>
          ) : null}
          {shown.map((run) => (
            <StreamingRunRow key={run.id} run={run} />
          ))}
          {history.runs.length > shown.length ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {`Showing the newest ${num(shown.length)} of ${plural(history.runs.length, "window")} in this response ${EMDASH} not every window ever.`}
            </Text>
          ) : null}
        </>
      );
  } else if (entry.errorStatus !== null) {
    body = (
      <Note tone="danger">
        {streamingHistoryErrorMessage(entry.errorStatus)}
      </Note>
    );
  } else if (loading) {
    body = (
      <SkeletonList
        rows={2}
        lines={2}
        label={`Loading shipped windows for ${entry.name}`}
      />
    );
  } else if (offline) {
    body = (
      <Note>
        Shipped windows need a connection. Reconnect and pull to refresh — this
        is not the same as nothing having shipped.
      </Note>
    );
  } else {
    body = <Note>No shipment history was read for this connection.</Note>;
  }

  return (
    <View style={{ marginBottom: 8 }}>
      <SectionLabel topMargin={8} subtitle={subtitle}>
        {entry.name}
      </SectionLabel>
      {body}
    </View>
  );
}
