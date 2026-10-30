/**
 * IdempotencyLedgerCard — "did that request run twice?".
 *
 * The idempotency inspector is five admin routes with no client on any surface;
 * the server even hands clients an `operator_replay_url` that nothing follows.
 * Its audience is somebody handed a message — "the customer says they were
 * charged twice" — which arrives at any hour, away from a desk, and is answered
 * by reading.
 *
 * It sits on Diagnostics beside the other support-facing state (build, push
 * token, stream, offline queue), because that is the screen somebody opens when
 * asked to explain what the app did.
 *
 * READ-ONLY. The delete route exists and is deliberately absent — see
 * `lib/idempotencyKeys` for why removing a deduplication guarantee is the one
 * destructive act whose failure mode is the exact problem being diagnosed.
 *
 * Self-gating: nothing renders without an answer, so a workspace with the
 * inspector disabled sees no empty card implying a feature it lacks.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import {
  useIdempotencyStats,
  usePendingIdempotencyKeys,
} from "@/hooks/useIdempotencyLedger";
import { FONT } from "@/lib/fonts";
import {
  idempotencyKeyLine,
  idempotencySummary,
  idempotencyTone,
  sortIdempotencyKeys,
} from "@/lib/idempotencyKeys";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function IdempotencyLedgerCard() {
  const { t } = useTheme();
  const stats = useIdempotencyStats();
  const pending = usePendingIdempotencyKeys((stats.data?.pending ?? 0) > 0);

  if (!stats.data) return null;
  const tone = idempotencyTone(stats.data);
  const rows = sortIdempotencyKeys(pending.data ?? []);

  return (
    <View style={{ marginTop: 16 }}>
      <Card>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
              flex: 1,
            }}
          >
            Repeat-request protection
          </Text>
          <Pill
            label={tone === "warning" ? "in flight" : "clear"}
            tone={tone === "warning" ? "warning" : "success"}
          />
        </View>

        <Text
          {...typeCap("caption")}
          style={{
            color: tone === "warning" ? t.warning : t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          {idempotencySummary(stats.data)}
        </Text>

        {rows.map((row) => (
          <Text
            key={row.key}
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 6,
            }}
            numberOfLines={2}
          >
            {idempotencyKeyLine(row)}
          </Text>
        ))}

        {tone === "warning" ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 8,
            }}
          >
            A request with no recorded result cannot be replayed, so a retry of
            it runs for real. Clearing or replaying a key is done from the web
            admin.
          </Text>
        ) : null}
      </Card>
    </View>
  );
}
