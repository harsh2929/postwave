/**
 * ScimTokenCard — one provisioning credential, and the one destructive
 * action a phone genuinely needs.
 *
 * A SCIM bearer can create, modify and deprovision workspace users. The
 * mobile screen listed them and said "revoke from desktop", which is the
 * wrong answer for the exact scenario a phone exists for: you are told a
 * token leaked while you are not at a desk.
 *
 * Two supporting changes make the revoke decision safe rather than brave:
 *   - DORMANCY. "Idle 120d" / "Never used" is the signal that separates a
 *     live IdP integration from forgotten credential surface.
 *   - TYPE-TO-CONFIRM. The confirm sheet asks for the token prefix, so
 *     revoking the wrong one takes deliberate effort, not a mis-tap.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import type { MobileScimTokenInfo } from "@/api/ops";
import { dateTime, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  canRevokeScimToken,
  scimTokenDormancy,
} from "@/lib/governanceActionPolicy";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ScimTokenCardProps {
  token: MobileScimTokenInfo;
  now: number;
  busy: boolean;
  /** False offline — a governance write is never queued for later replay. */
  canAct: boolean;
  onRevoke: (token: MobileScimTokenInfo) => void;
  onShare: (token: MobileScimTokenInfo) => void;
}

export function ScimTokenCard({
  token,
  now,
  busy,
  canAct,
  onRevoke,
  onShare,
}: ScimTokenCardProps) {
  const { t } = useTheme();
  const revoked = Boolean(token.revoked_at);
  const name = token.description || "SCIM token";
  const dormancy = scimTokenDormancy(token, now);
  const revocable = canRevokeScimToken(token) && canAct;

  // One relative age instead of two full locale timestamps: a phone-width
  // row cannot carry "7/25/2026, 4:05:11 PM" twice, and "3d ago" is what
  // the reader is actually computing anyway. The absolute stamps stay in
  // the spoken label so nothing is lost to assistive tech.
  const created = relativeTime(token.created_at, { now, fallback: "—" });
  const lastUsed = token.last_used_at
    ? relativeTime(token.last_used_at, { now, fallback: "—" })
    : "never used";

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
        opacity: revoked ? 0.55 : 1,
      }}
    >
      <View
        accessible
        accessibilityLabel={`${name}, prefix ${token.prefix || "none"}, ${
          revoked ? "revoked" : "active"
        }. Created ${dateTime(token.created_at, "unknown")}. ${
          token.last_used_at
            ? `Last used ${dateTime(token.last_used_at, "unknown")}`
            : "Never used"
        }.${dormancy ? ` ${dormancy.label}.` : ""}`}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text
              {...typeCap("body")}
              numberOfLines={1}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              {name}
            </Text>
            {/* The prefix is the string the reader types into the revoke
                confirm, so it takes the `mono` role: copied verbatim, never
                reflowed. */}
            <Text
              selectable
              numberOfLines={1}
              {...typeCap("mono")}
              style={{
                color: t.fgMuted,
                fontFamily: "Menlo",
                ...typeStyle("mono"),
                marginTop: 2,
              }}
            >
              {token.prefix || "—"}
            </Text>
          </View>
          <Pill
            label={revoked ? "revoked" : "active"}
            tone={revoked ? "danger" : "success"}
          />
        </View>
        <View
          style={{
            flexDirection: "row",
            gap: 6,
            marginTop: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {dormancy ? (
            <Pill
              label={dormancy.label}
              tone={dormancy.tone === "neutral" ? "neutral" : dormancy.tone}
            />
          ) : null}
          {/* No `numberOfLines`: the parent row wraps, so at large text sizes
              this ages readout gains a line instead of truncating to
              "Created 3d ago · use…". */}
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              flexShrink: 1,
            }}
          >
            {`Created ${created} · used ${lastUsed}`}
          </Text>
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
        <CardAction
          label="Share prefix"
          hint="Opens the share sheet with this token's prefix"
          onPress={() => onShare(token)}
        />
        {!revoked ? (
          <CardAction
            label={busy ? "Revoking…" : "Revoke"}
            hint="Permanently disables this provisioning token"
            destructive
            disabled={!revocable || busy}
            onPress={() => onRevoke(token)}
          />
        ) : null}
      </View>
    </View>
  );
}

function CardAction({
  label,
  hint,
  destructive,
  disabled,
  onPress,
}: {
  label: string;
  hint: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  const colour = destructive ? t.danger : t.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled ?? false}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={{
        flex: 1,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colour,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: colour,
          ...typeStyle("control"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
