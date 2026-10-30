/**
 * What already exists on the destination, for someone mid-migration.
 *
 * The snapshot behind this card was written, exported, re-exported through
 * `api/client.ts`, and rendered by nothing — a re-export is not a consumer,
 * which is exactly why a grep for the symbol found two hits while the product
 * had zero. This is the consumer.
 *
 * It answers one question — "how much of my Mailchimp setup is already here" —
 * and it is only ever asked while looking at a migration, which is why it lives
 * on this screen rather than a tab of its own.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import type { MobileMailchimpParitySnapshot } from "@/api/mobileParity";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

/**
 * A count and what it counts.
 *
 * Zero is rendered, never hidden. "Nothing has landed yet" is the single most
 * useful thing this card can say to someone halfway through an import, and
 * dropping empty rows would leave them looking at a shorter card with no way to
 * tell it apart from one still loading.
 */
function ParityRow({ label, value }: { label: string; value: number }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingVertical: 6,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{ color: t.fgMuted, fontFamily: FONT.regular, fontSize: 14 }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("body")}
        style={{ color: t.fg, fontFamily: FONT.medium, fontSize: 15 }}
      >
        {num(value)}
      </Text>
    </View>
  );
}

export function MigrationParityCard({
  snapshot,
}: {
  snapshot: MobileMailchimpParitySnapshot;
}) {
  const { t } = useTheme();
  return (
    <Card>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <Text
          {...typeCap("heading")}
          style={{ color: t.fg, fontFamily: FONT.medium, fontSize: 16 }}
        >
          Already on Moosewave
        </Text>
        {snapshot.content_status ? (
          <Pill label={snapshot.content_status} tone="neutral" />
        ) : null}
      </View>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          fontSize: 13,
          marginBottom: 8,
        }}
      >
        Counted live from your account, not from the import job — so it reflects
        everything that is here, however it arrived.
      </Text>
      <ParityRow label="Planner touchpoints" value={snapshot.planner_touchpoints} />
      <ParityRow label="Planner tasks" value={snapshot.planner_tasks} />
      <ParityRow label="Channels" value={snapshot.channels} />
      <ParityRow label="Audience dimensions" value={snapshot.audience_dimensions} />
      <ParityRow label="Content files" value={snapshot.content_files} />
    </Card>
  );
}
