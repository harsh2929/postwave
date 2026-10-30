/**
 * TimelineFilterBar — the facet switch above a subscriber's activity feed,
 * and the disclosure that keeps it honest.
 *
 * The rules it renders live in src/lib/timelineFilter.ts (import-free, tested).
 * The one thing to keep in mind editing this file: the endpoint has no type
 * parameter, so the filter can only narrow the pages already fetched. The note
 * under the control is therefore not decoration — without it, an empty
 * "Problems" facet reads as "this person has never bounced" when it means
 * "not in the 200 events loaded so far".
 */
import { Text, View } from "react-native";

import { SegmentedControl } from "@/components/SegmentedControl";
import { FONT } from "@/lib/fonts";
import {
  TIMELINE_FACETS,
  timelineFilterNote,
  type TimelineFacet,
} from "@/lib/timelineFilter";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function TimelineFilterBar({
  facet,
  onChange,
  counts,
  shown,
  loaded,
  unclassified,
  hasMore,
}: {
  facet: TimelineFacet;
  onChange: (next: TimelineFacet) => void;
  counts: Record<TimelineFacet, number>;
  shown: number;
  loaded: number;
  unclassified: number;
  hasMore: boolean;
}) {
  const { t } = useTheme();
  // Nothing loaded means nothing to filter; a control over an empty list is
  // four dead tap targets.
  if (loaded === 0) return null;

  const note = timelineFilterNote({
    facet,
    shown,
    loaded,
    unclassified,
    hasMore,
  });

  return (
    <View style={{ marginTop: 16, gap: 6 }}>
      <SegmentedControl
        accessibilityLabel="Filter activity by type"
        scrollable
        options={TIMELINE_FACETS.map((f) => ({
          value: f.value,
          label: f.label,
          badge: counts[f.value],
        }))}
        value={facet}
        onChange={onChange}
      />
      {note ? (
        <Text
          // Spoken as a live region: the sentence changes meaning the moment
          // the facet does, and a caveat nobody hears is not a caveat.
          accessibilityLiveRegion="polite"
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {note}
        </Text>
      ) : null}
    </View>
  );
}
