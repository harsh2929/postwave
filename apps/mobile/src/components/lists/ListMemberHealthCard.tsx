/**
 * ListMemberHealthCard — "how much of this roster should I not be mailing?",
 * asked once instead of one subscriber at a time.
 *
 * POST /api/v1/verification/health/batch has been fully implemented and fully
 * validated on this client since it was written, with no call site at all:
 * only the SINGLE-address sibling was ever rendered
 * (SubscriberEmailHealthCard), so the answer to a question about a list was
 * reachable only by opening its members one by one.
 *
 * THREE THINGS IT REFUSES TO DO, each of which would make the number a claim
 * rather than a measurement:
 *
 *  - IT NEVER RUNS ON ITS OWN. The input is whatever the paginated members
 *    list happens to have materialised, so an automatic read would re-fire on
 *    every page append and grade a moving target. The person presses the
 *    button, and the button says how many addresses it is about to ask about.
 *  - IT SAYS "THE LOADED MEMBERS", NEVER "THE LIST". Scrolling loads more; the
 *    check covers what is here now, and the caption is written so it cannot be
 *    read as a statement about the whole roster.
 *  - IT SURFACES INCOMPLETE EVIDENCE. `evidence_complete: false` means the
 *    server could not assemble everything a grade rests on. Folding those rows
 *    silently into their grade would present a provisional answer as a
 *    finished one.
 *
 * NativeWind v4 house rule: the Pressable style is a STATIC object.
 */
import { Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import { useEmailHealthBatch } from "@/hooks/useEmailHealthBatch";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { plural } from "@/lib/format";
import {
  healthRollupHeadline,
  normalizeHealthAddresses,
  type EmailHealthRollup,
} from "@/lib/emailHealthRollup";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * The same vocabulary SubscriberEmailHealthCard uses for one address. Two
 * surfaces describing the same grade differently is how a person ends up
 * believing they measured two different things.
 */
const GRADE_LABEL = {
  A: "Recently validated",
  B: "Positive activity",
  C: "Catch-all",
  D: "Negative activity",
  F: "Invalid or blocked",
  U: "Not enough evidence",
} as const;

const GRADE_ORDER = ["F", "D", "C", "U", "B", "A"] as const;

export function ListMemberHealthCard({
  emails,
  blocked,
}: {
  /** Addresses of the members materialised right now. */
  emails: readonly (string | null | undefined)[];
  /** The online gate is closed — the screen already says why. */
  blocked: boolean;
}) {
  const { t } = useTheme();
  const check = useEmailHealthBatch();
  const checkable = normalizeHealthAddresses(emails).length;
  const result = check.data ?? null;

  // Nothing loaded, nothing to offer. An empty card under an empty roster is
  // one more thing to read and no more information.
  if (checkable === 0 && !result) return null;

  const onCheck = () => {
    if (blocked || check.isPending || checkable === 0) return;
    haptics.tap();
    check.mutate(emails);
  };

  return (
    <Card accessibilityLabel="Email health of loaded members" style={{ marginBottom: 12 }}>
      <Label>Email health</Label>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          marginTop: 6,
        }}
      >
        Grades the members loaded on this screen right now — not the whole
        list. Scroll to load more, then check again.
      </Text>

      <View style={{ marginTop: 10, alignItems: "flex-start" }}>
        <Pressable
          onPress={onCheck}
          disabled={blocked || check.isPending || checkable === 0}
          accessibilityRole="button"
          accessibilityLabel={
            check.isPending
              ? "Checking email health"
              : `Check ${plural(checkable, "loaded member")}`
          }
          accessibilityState={{
            disabled: blocked || check.isPending || checkable === 0,
          }}
          style={{
            backgroundColor:
              blocked || check.isPending || checkable === 0
                ? t.bgSubtle
                : t.surface,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 14,
            paddingVertical: 10,
            minHeight: 44,
            justifyContent: "center",
            opacity: blocked || check.isPending ? 0.6 : 1,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.semibold,
            }}
          >
            {check.isPending
              ? "Checking…"
              : `Check ${plural(checkable, "loaded member")}`}
          </Text>
        </Pressable>
      </View>

      {check.error ? (
        <View style={{ marginTop: 10 }}>
          <ErrorState
            compact
            error={check.error}
            message="Couldn't grade these addresses."
            onRetry={onCheck}
          />
        </View>
      ) : null}

      {result ? <Rollup rollup={result.rollup} /> : null}
    </Card>
  );
}

function Rollup({ rollup }: { rollup: EmailHealthRollup }) {
  const { t } = useTheme();
  const rows = GRADE_ORDER.filter((grade) => rollup.summary[grade] > 0);
  return (
    <View style={{ marginTop: 12, gap: 6 }} accessibilityLiveRegion="polite">
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: rollup.doNotSend > 0 ? t.warning : t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.semibold,
        }}
      >
        {healthRollupHeadline(rollup)}
      </Text>
      {rows.map((grade) => (
        <View
          key={grade}
          accessible
          accessibilityLabel={`${GRADE_LABEL[grade]}: ${rollup.summary[grade]}`}
          style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              flexShrink: 1,
            }}
          >
            {GRADE_LABEL[grade]}
          </Text>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fg,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            {rollup.summary[grade]}
          </Text>
        </View>
      ))}
      {rollup.incompleteEvidence > 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {`${plural(rollup.incompleteEvidence, "grade")} rest on evidence the server could not fully assemble, so ${
            rollup.incompleteEvidence === 1 ? "it is" : "they are"
          } provisional.`}
        </Text>
      ) : null}
    </View>
  );
}
