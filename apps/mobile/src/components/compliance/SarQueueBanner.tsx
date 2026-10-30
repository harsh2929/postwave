/**
 * SarQueueBanner — how close the oldest subject-access request is to its
 * statutory deadline.
 *
 * The DSAR surface (`sar.go`: create / list / fetch / `{id}.zip` /
 * store-responses) is desktop-only; mobile had no SAR path at all. This is
 * deliberately the smallest useful slice: a COUNT and a CLOCK.
 *
 * ── WHY ONLY THIS MUCH ─────────────────────────────────────────────────────
 * Fulfilling a request is desk work. Noticing you are eight days from missing a
 * GDPR Art. 12(3) deadline is not — that is precisely the thing you want to
 * learn while away from the desk, because it is the only point at which you can
 * still do something about it.
 *
 * There is no download here and there never should be. `{id}.zip` hands over a
 * bundle of one person's personal data; a phone is the worst available place to
 * receive it — a shared Downloads folder, possibly a personal handset, no chain
 * of custody. The header of `api/complianceOps.ts` says so too, so that nobody
 * later reads the omission as an oversight.
 *
 * Renders nothing when the queue is empty. An "all clear" banner on a
 * compliance screen is noise that trains people to skip the region where the
 * real warning will eventually appear.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { useSarRequests } from "@/hooks/useComplianceOps";
import { sarQueueSummary, sarQueueUrgency } from "@/lib/complianceOps";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SarQueueBanner() {
  const { t } = useTheme();
  const query = useSarRequests();
  const rows = query.data ?? [];
  const summary = sarQueueSummary(rows);
  if (!summary) return null;

  const urgency = sarQueueUrgency(rows);
  const colour =
    urgency === "overdue" ? t.danger : urgency === "due_soon" ? t.warning : t.fgMuted;

  return (
    <View style={{ marginTop: 12 }}>
      <Card>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.semibold,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          Subject requests
        </Text>
        <Text
          // A missed statutory deadline is exactly the class of thing a screen
          // reader user should hear on arrival rather than on encounter.
          accessibilityRole={urgency === "overdue" ? "alert" : "text"}
          {...typeCap("caption")}
          style={{
            color: colour,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          {summary}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          Fulfilling a request, and downloading its bundle, stays on the web
          admin — a data export is not something to hand a phone.
        </Text>
      </Card>
    </View>
  );
}
