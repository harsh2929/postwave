/**
 * SecurityActivitySection — recent sign-ins, MFA changes and token grants,
 * inlined beside the security controls in Settings (AUTH#8, half b).
 *
 * Half (a) of AUTH#8 — the named one-tap Security lens on the audit tab —
 * shipped in an earlier round as `SECURITY_ACTION_KEYWORDS` / `isSecurityAction`
 * in lib/auditViews.ts. This is half (b), and apps/web states the reason it
 * exists better than a comment can: its security settings page inlines the top
 * matching rows (settings/security/security-activity-card.tsx) "explicitly so
 * users don't have to correlate in the full log". A user who has just turned on
 * app lock and wants to know whether anyone else signed in should not have to
 * discover that a different tab exists, find its filter, and apply it.
 *
 * Three decisions:
 *
 *  - IT REUSES THE SAME KEYWORD SET. `isSecurityAction` is the single
 *    definition of "security event" across the audit lens, apps/web and this
 *    card. Two definitions would mean the products quietly disagree about what
 *    counts, which is the sort of thing an auditor finds and a changelog never
 *    mentions.
 *  - IT IS SCOPE-GATED, NOT ROLE-GATED. GET /api/v1/audit sits behind
 *    `audit:read`; `/api/v1/audit/my-scopes` is deliberately ungated so the
 *    answer always arrives. Without the scope this renders NOTHING rather than
 *    a locked panel — the audit tab already owns that explanation.
 *  - A FAILED READ IS NEVER AN ALL-CLEAR. "We couldn't look" and "nothing
 *    happened" are opposite reassurances on a security screen, and
 *    `securityActivityState` keeps them apart. The rules are unit-tested in
 *    src/lib/securityActivity.ts.
 */
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";

import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import {
  hasAuditReadScope,
  useAuditLog,
  useAuditScopes,
} from "@/hooks/useAudit";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isSecurityAction } from "@/lib/auditViews";
import { forwardArrow } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { dateTime, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  recentSecurityActivity,
  securityActionLabel,
  securityActivityState,
  securityActorLine,
  SECURITY_ACTIVITY_LIMIT,
} from "@/lib/securityActivity";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * One page is plenty: this is the five most recent security rows, and paging
 * for more would be the audit tab's job. Deliberately larger than the display
 * limit because the filter is CLIENT-side over what arrived — asking for five
 * rows would show five security events only on a workspace where nothing else
 * happened.
 */
const SCAN_PAGE = 100;

export function SecurityActivitySection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const scopes = useAuditScopes();
  const canRead = hasAuditReadScope(scopes.data);
  // Shares the audit tab's default query key shape, so opening Settings after
  // the audit tab costs no request at all.
  const audit = useAuditLog(SCAN_PAGE, undefined, { enabled: canRead === true });

  const rows = useMemo(() => {
    const all = (Array.isArray(audit.data?.pages) ? audit.data?.pages : []).flatMap((page) => page.rows);
    return recentSecurityActivity(all, isSecurityAction, SECURITY_ACTIVITY_LIMIT);
  }, [audit.data]);

  const state = securityActivityState({
    canRead,
    online: gate.enabled,
    loading: audit.isLoading,
    failed: audit.isError,
    rowCount: rows.length,
  });

  if (state.kind === "hidden") return null;

  return (
    <>
      <SectionHeader
        anchor="security-activity"
        title="Recent security activity"
        subtitle="Sign-ins, MFA changes and token grants on this workspace."
      />
      <Card>
        {state.kind === "loading" ? <SkeletonList rows={3} /> : null}

        {state.kind === "failed" ? (
          <Text
            accessibilityRole="alert"
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {state.message}
          </Text>
        ) : null}

        {state.kind === "empty" ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {state.message}
          </Text>
        ) : null}

        {state.kind === "rows"
          ? rows.map((row) => <ActivityRow key={row.id} row={row} />)
          : null}

        <Pressable
          onPress={() => {
            haptics.tap();
            // Lands on the audit tab with the Security lens ALREADY on, so the
            // card and the screen it hands off to are showing the same set.
            router.push("/(tabs)/audit?lens=security");
          }}
          accessibilityRole="button"
          accessibilityLabel="Open the audit log filtered to security events"
          hitSlop={8}
          style={{
            minHeight: 44,
            justifyContent: "center",
            marginTop: 10,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {`See all security events ${forwardArrow()}`}
          </Text>
        </Pressable>
      </Card>
    </>
  );
}

function ActivityRow({
  row,
}: {
  row: {
    id: number;
    action: string;
    actorLabel?: string | null;
    actorType?: string;
    ip?: string | null;
    at: string;
  };
}) {
  const { t } = useTheme();
  const label = securityActionLabel(row.action);
  const actor = securityActorLine(row);
  const when = relativeTime(row.at, { fallback: "" });
  const exact = dateTime(row.at, "");
  return (
    <View
      accessible
      // One spoken sentence: a relative timestamp read on its own ("3h ago")
      // is meaningless beside an action the reader has not heard yet.
      accessibilityLabel={`${label}. ${actor}. ${exact || when || "Time unknown"}.`}
      style={{ paddingVertical: 7 }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.semibold,
        }}
        numberOfLines={2}
      >
        {label}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 2,
          fontFamily: FONT.regular,
        }}
        numberOfLines={1}
      >
        {when ? `${actor} · ${when}` : actor}
      </Text>
    </View>
  );
}
