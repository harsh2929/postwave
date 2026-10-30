/**
 * ActiveDevicesSection — the phone-side "sign my other devices out" surface.
 *
 * The three endpoints have existed since sessions_handler.go shipped and no
 * mobile screen called any of them, so the one security action a phone is
 * uniquely good at — you always have it, and it is the device you reach for
 * when a laptop goes missing — was unavailable on the device you always have.
 *
 * Design notes:
 *   - Revocation is IRREVERSIBLE (a revoked session cannot be restored), so
 *     each destructive verb goes through ConfirmSheet rather than a toast-with
 *     -undo, and "sign out everything else" additionally names the count.
 *   - The current device is pinned first and cannot be revoked from here;
 *     signing THIS phone out is what the Sign out control is for, and mixing
 *     the two invites a mis-tap that strands the user.
 *   - Nothing is cached. A stale list on a security screen is worse than no
 *     list; when the gate is closed the user gets a reconnect notice.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import {
  CachedSessionNotice,
  cachedSessionNotice,
} from "@/components/CachedSessionNotice";
import { Pill } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  useLogoutOtherSessions,
  useRevokeSession,
  useSessions,
  type AuthSessionInfo,
} from "@/hooks/useSessions";
import { announce } from "@/lib/a11y";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { deviceLabel, sessionRowSummary } from "@/lib/sessionDevice";
import { sessionExpiryNotice } from "@/lib/sessionExpiryNotice";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ActiveDevicesSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const logoutOthers = useLogoutOtherSessions();
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Array.isArray, not `?? []`. The nullish guard admits any TRUTHY non-array
  // -- a paged `{items: []}` envelope, or the HTML an SPA fallback serves for
  // an absent upstream -- straight into the iteration below.
  const rows = Array.isArray(sessions.data) ? sessions.data : [];
  const others = rows.filter((row) => !row.current);
  const notice = cachedSessionNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
    surface: "sessions",
  });

  async function onRevoke(row: AuthSessionInfo): Promise<void> {
    const label = row.device_label || deviceLabel(row.user_agent);
    const ok = await confirm({
      title: `Sign out ${label}?`,
      message:
        "That device will need to sign in again. This cannot be undone from here.",
      confirmLabel: "Sign out",
      destructive: true,
      consequence: `Last active ${relativeTime(row.last_seen_at)}.`,
    });
    if (!ok) return;
    setPendingId(row.id);
    try {
      await revoke.mutateAsync(row.id);
      haptics.success();
      toast({ kind: "success", message: `${label} signed out.` });
    } catch (error) {
      haptics.error();
      toast({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Couldn't sign that device out.",
      });
    } finally {
      setPendingId(null);
    }
  }

  async function onLogoutOthers(): Promise<void> {
    const ok = await confirm({
      title: "Sign out every other device?",
      message:
        "Every browser, CLI and phone except this one will need to sign in again.",
      confirmLabel: "Sign out all",
      destructive: true,
      consequence: `${others.length} other ${
        others.length === 1 ? "session" : "sessions"
      } will end immediately.`,
    });
    if (!ok) return;
    try {
      const count = await logoutOthers.mutateAsync();
      haptics.success();
      const message = `Signed out ${count} other ${
        count === 1 ? "device" : "devices"
      }.`;
      toast({ kind: "success", message });
      announce(message);
    } catch (error) {
      haptics.error();
      toast({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Couldn't sign the other devices out.",
      });
    }
  }

  return (
    <>
      <SectionHeader
        title="Active devices"
        subtitle="Everywhere your account is signed in right now."
      />
      {notice ? (
        <CachedSessionNotice notice={notice} style={{ marginBottom: 10 }} />
      ) : null}
      <Card>
        <QueryStates
          query={sessions}
          isEmpty={rows.length === 0}
          gate={gate}
          skeleton={<SkeletonList rows={3} />}
          empty={{
            title: "No other sessions",
            description:
              "This phone is the only place your account is signed in.",
          }}
          offlineMessage="Reconnect to review the devices signed in to your account. Session lists are never cached."
        >
          {rows.map((row, index) => (
            <SessionRow
              key={row.id}
              row={row}
              first={index === 0}
              busy={pendingId === row.id}
              onRevoke={() => void onRevoke(row)}
            />
          ))}
        </QueryStates>

        {others.length > 0 ? (
          <Pressable
            onPress={() => void onLogoutOthers()}
            disabled={logoutOthers.isPending}
            accessibilityRole="button"
            accessibilityLabel={`Sign out all ${others.length} other devices`}
            accessibilityState={{
              disabled: logoutOthers.isPending,
              busy: logoutOthers.isPending,
            }}
            style={{
              marginTop: 12,
              paddingVertical: 10,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.danger,
              backgroundColor: `${t.danger}1a`,
              alignItems: "center",
              justifyContent: "center",
              minHeight: 44,
              opacity: logoutOthers.isPending ? 0.6 : 1,
            }}
          >
            {logoutOthers.isPending ? (
              <ActivityIndicator color={t.danger} />
            ) : (
              <Text
                {...typeCap("body")}
                style={{
                  color: t.danger,
                  ...typeStyle("body"),
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                }}
              >
                Sign out all other devices
              </Text>
            )}
          </Pressable>
        ) : null}
      </Card>
    </>
  );
}

function SessionRow({
  row,
  first,
  busy,
  onRevoke,
}: {
  row: AuthSessionInfo;
  first: boolean;
  busy: boolean;
  onRevoke: () => void;
}) {
  const { t } = useTheme();
  const parsedSummary = sessionRowSummary({
    userAgent: row.user_agent ?? null,
    authMethod: row.auth_method,
    ip: row.ip ?? null,
    current: row.current,
  });
  const summary = {
    ...parsedSummary,
    title: row.device_label || parsedSummary.title,
  };
  const lastSeen = relativeTime(row.last_seen_at);
  // Only on THIS device's row. `session_max_minutes` is enforced server-side
  // and was surfaced nowhere, so a short workspace policy was indistinguishable
  // from a bug — you found out by being thrown out mid-task. Other devices'
  // deadlines are not actionable from here, so they stay quiet.
  const expiry = row.current
    ? sessionExpiryNotice(row.expires_at, Date.now())
    : null;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.borderSubtle,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text
            // Row title beside a "This device" pill: prose that shrinks, so
            // `body` with its own ceiling rather than the pill's.
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {summary.title}
          </Text>
          {/* Text, not a colour: "this device" must survive colour-blindness
              and a screen reader, because it is the row you must NOT revoke. */}
          {summary.current ? <Pill label="This device" tone="accent" /> : null}
        </View>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
          numberOfLines={1}
        >
          {summary.detail}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
          numberOfLines={1}
        >
          {`Active ${lastSeen}`}
        </Text>
        {expiry ? (
          // Urgency is carried by the WORDS ("Expires in 8 minutes"), so the
          // colour is reinforcement, never the signal.
          <Text
            {...typeCap("caption")}
            accessibilityLabel={expiry.spoken}
            style={{
              color: expiry.urgent ? t.warning : t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: expiry.urgent ? FONT.semibold : FONT.regular,
            }}
            numberOfLines={1}
          >
            {expiry.text}
          </Text>
        ) : null}
      </View>
      {summary.current ? null : (
        <Pressable
          onPress={onRevoke}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Sign out ${summary.title}, last active ${lastSeen}`}
          accessibilityState={{ disabled: busy, busy }}
          hitSlop={6}
          style={{
            minHeight: 44,
            minWidth: 44,
            paddingHorizontal: 10,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? (
            <ActivityIndicator color={t.danger} />
          ) : (
            <Text
              // Compact trailing action sharing the row with the device
              // summary: it must not grow the row's title out of the way.
              {...typeCap("control")}
              style={{
                color: t.danger,
                ...typeStyle("control"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Sign out
            </Text>
          )}
        </Pressable>
      )}
    </View>
  );
}
