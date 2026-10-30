/**
 * IpPoolCard — read-only "which IPs is this workspace sending from?".
 *
 * Mobile parity for desktop's IpPoolDomainCard (SendingSettings.tsx:851),
 * minus the domains half: sender domains have their own mobile surface, while
 * the pool assignment had none. The data rides the already-fetched
 * GET /settings/sending row; the parse and the honesty rule (absent ≠ Shared)
 * are pure, in lib/ipPool.ts.
 *
 * Deliberately not a control: dedicated pools are provisioned by support, so
 * the card states the assignment and who changes it, and offers no affordance
 * that could not work.
 *
 * IT TAKES THE WHOLE ROW, NOT THE POOL FIELD. `row?.ip_pool` is `undefined`
 * both when a verified response omitted the projection and when no response
 * was ever loaded (the gate can be closed while the screen still renders its
 * body — see the first case in __tests__/sending-settings.native.test.tsx).
 * Those are different sentences, and a prop that is only the field cannot
 * tell them apart, so the caller hands over the row and the card asks it.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { describeIpPool, ipPoolLine } from "@/lib/ipPool";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function IpPoolCard({
  row,
}: {
  row: { ip_pool?: { name?: string; dedicated?: boolean } | null } | undefined;
}) {
  const { t } = useTheme();
  const pool = describeIpPool(row?.ip_pool, row !== undefined);
  return (
    <View
      accessible
      accessibilityLabel={`Sending IP pool: ${ipPoolLine(pool)}.${pool.kind === "known" ? " Dedicated pools are provisioned and managed by support." : ""}`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 14,
        gap: 6,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          letterSpacing: 0.6,
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
        }}
      >
        Sending IP pool
      </Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: pool.kind === "known" ? t.fg : t.fgMuted,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
          }}
        >
          {pool.kind === "known" ? pool.name : ipPoolLine(pool)}
        </Text>
        {pool.kind === "known" ? (
          <Pill
            label={pool.dedicated ? "Dedicated" : "Shared"}
            tone={pool.dedicated ? "info" : "neutral"}
          />
        ) : null}
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {pool.kind === "known"
          ? "Configuration projects this pool assignment; the actual message route and provider lane are not certified here. Dedicated pools (including their warm-up schedule) are provisioned and managed by support."
          : pool.kind === "not_reported"
            ? "The verified settings response did not include an IP-pool projection. Moosewave will not assume a shared or dedicated lane."
            : "Moosewave has not verified a settings response for this workspace. Retry before relying on routing context."}
      </Text>
    </View>
  );
}
