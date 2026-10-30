/**
 * NotificationPreferencesSection — three boolean toggles (send-complete,
 * approval-request, bounce-alert), a daily/weekly/never digest selector, and
 * the usage/spend alert threshold. Mirrors the desktop's notification panel
 * and POSTs to /api/v1/settings/notifications.
 *
 * The usage alert (BILL-038) shipped server-side and on web long before this
 * screen learned about it: `usage_alert_threshold_pct` and
 * `email_on_usage_alert` are both selected and upserted by the Go handler
 * (apps/api/internal/settings/notifications.go:35, :104, :123-135) and read
 * by apps/web's billing page, but mobile's `NotificationPrefs` type declared
 * neither — so the two fields were silently dropped on read AND unsettable on
 * write. The control is discrete chips rather than web's number input; see
 * src/lib/usageAlertThreshold.ts for why, and for the "absent is not zero"
 * rule the pointer field forces.
 */
import { useEffect, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";

import {
  getNotificationPrefs,
  patchNotificationPrefs,
  sendTestNotification,
  type NotificationPrefs,
} from "@/api/settings";
import { Chip } from "@/components/Chip";
import { ChipRow } from "@/components/ChipRow";
import { useToast } from "@/components/Toast";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  testSendOutcome,
  type TestSendOutcome,
} from "@/lib/notificationTestSend";
import { useTheme } from "@/lib/theme";
import {
  normalizeThreshold,
  thresholdOptions,
  thresholdPatch,
  thresholdSummary,
} from "@/lib/usageAlertThreshold";
import { typeCap, typeStyle } from "@/lib/typeScale";

type Frequency = "daily" | "weekly" | "never";

const FREQS: readonly { key: Frequency; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "never", label: "Never" },
];

function isFreq(s: string): s is Frequency {
  return s === "daily" || s === "weekly" || s === "never";
}

export function NotificationPreferencesSection() {
  const { t } = useTheme();
  const { toast } = useToast();
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getNotificationPrefs();
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        if (res.error.status === 404 || res.error.status === 501) {
          setUnavailable(true);
        }
        return;
      }
      setPrefs(res.data ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = async (
    patch: Parameters<typeof patchNotificationPrefs>[0],
  ) => {
    if (!prefs) return;
    // Optimistic: apply locally first, roll back on error.
    const prev = prefs;
    setPrefs({ ...prefs, ...patch } as NotificationPrefs);
    const res = await patchNotificationPrefs(patch);
    if (res.error || !res.data) {
      setPrefs(prev);
      const detail = res.error?.message ?? "";
      const message = `Couldn't update notification preferences. ${detail}`;
      toast({ kind: "error", message: message.trim() });
      return;
    }
    setPrefs(res.data);
  };

  if (unavailable) {
    return (
      <Notice text="Notification preferences unavailable on this deployment." />
    );
  }
  if (loading) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        Loading notification preferences…
      </Text>
    );
  }
  if (!prefs) {
    return <Notice text="Couldn't load notification preferences." />;
  }

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 16,
        padding: 14,
        gap: 14,
      }}
    >
      <ToggleRow
        label="Send complete"
        hint="Email when a campaign finishes sending."
        value={prefs.email_on_send_complete}
        onValueChange={(v) => void update({ email_on_send_complete: v })}
      />
      <ToggleRow
        label="Approval requested"
        hint="Email when a teammate asks you to approve a send."
        value={prefs.email_on_approval_request}
        onValueChange={(v) => void update({ email_on_approval_request: v })}
      />
      <ToggleRow
        label="Bounce alert"
        hint="Email when bounce rate crosses your workspace threshold."
        value={prefs.email_on_bounce_alert}
        onValueChange={(v) => void update({ email_on_bounce_alert: v })}
      />
      <View>
        <Text
          accessibilityRole="header"
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            letterSpacing: 0.5,
            fontWeight: "600",
            fontFamily: FONT.semibold,
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          Digest frequency
        </Text>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {FREQS.map((f) => (
            <Chip
              key={f.key}
              label={f.label}
              active={
                isFreq(prefs.digest_frequency)
                  ? prefs.digest_frequency === f.key
                  : false
              }
              onPress={() => void update({ digest_frequency: f.key })}
            />
          ))}
        </View>
      </View>
      <UsageAlertBlock prefs={prefs} onUpdate={update} />
      <TestSendBlock />
    </View>
  );
}

/**
 * "Do any of these actually reach me?" — the question every toggle above begs
 * and none of them answers.
 *
 * POST /api/v1/settings/notifications/test is the third route on the same
 * object as the GET and PATCH this section already speaks, and mobile owned
 * neither the call nor the control. The outcome copy lives in
 * lib/notificationTestSend.ts because two of the server's four answers are
 * product boundaries rather than faults, and "check your connection" is the
 * wrong sentence for both.
 */
function TestSendBlock() {
  const { t } = useTheme();
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<TestSendOutcome | null>(null);

  async function onSend(): Promise<void> {
    if (sending) return;
    setSending(true);
    // Clearing first: a stale success line under a running attempt reads as
    // the result of the attempt.
    setOutcome(null);
    try {
      const next = testSendOutcome(await sendTestNotification());
      setOutcome(next);
      if (next.kind === "success") haptics.success();
      else haptics.error();
    } finally {
      setSending(false);
    }
  }

  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 14,
        gap: 8,
      }}
    >
      <Pressable
        onPress={() => void onSend()}
        disabled={sending}
        accessibilityRole="button"
        accessibilityLabel="Send a test notification"
        accessibilityHint="Emails a sample notification to your own address so you can confirm it arrives."
        accessibilityState={{ disabled: sending, busy: sending }}
        style={{
          minHeight: 44,
          justifyContent: "center",
          alignItems: "center",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
          opacity: sending ? 0.6 : 1,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {sending ? "Sending…" : "Send a test notification"}
        </Text>
      </Pressable>
      {outcome ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          {...typeCap("caption")}
          style={{
            color: outcome.kind === "success" ? t.fgMuted : t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {outcome.message}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The usage/spend alert (BILL-038). Split out so the section's main function
 * stays inside its size budget, and because the "absent is not zero" rule
 * needs a comment where it is applied rather than three files away.
 */
function UsageAlertBlock({
  prefs,
  onUpdate,
}: {
  prefs: NotificationPrefs;
  onUpdate: (patch: Parameters<typeof patchNotificationPrefs>[0]) => Promise<void>;
}) {
  const { t } = useTheme();
  // The Go field is a *int with omitempty: no threshold means the key is
  // MISSING, so `?? 0` here would be indistinguishable from a user who chose
  // "warn me at 0%". normalizeThreshold keeps absent as null.
  const threshold = normalizeThreshold(prefs.usage_alert_threshold_pct);
  // The response field defaults to true server-side (defaultPrefs), but an
  // older deployment may omit it; treat a missing value as ON to match the
  // server default rather than inventing a quieter one.
  const emailOnAlert = prefs.email_on_usage_alert !== false;
  const options = thresholdOptions(threshold);

  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 14,
        gap: 8,
        // Negative inset so ChipRow's own 16pt scroller padding lines the
        // chips up with the card's 14pt padding instead of double-indenting.
        marginHorizontal: -14,
        paddingHorizontal: 14,
      }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          letterSpacing: 0.5,
          fontWeight: "600",
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
        }}
      >
        Usage alert
      </Text>
      <View style={{ marginHorizontal: -14 }}>
        <ChipRow
          options={options.map((o) => ({
            value: String(o.value),
            label: o.label,
            accessibilityLabel: o.accessibilityLabel,
          }))}
          value={String(threshold ?? 0)}
          onChange={(next) =>
            void onUpdate(thresholdPatch(Number(next)))
          }
          accessibilityLabel="Usage alert threshold"
          paddingHorizontal={14}
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {thresholdSummary({ threshold, emailOnAlert })}
      </Text>
      {threshold != null ? (
        <ToggleRow
          label="Email me too"
          hint="Send an email the first time the threshold is crossed."
          value={emailOnAlert}
          onValueChange={(v) => void onUpdate({ email_on_usage_alert: v })}
        />
      ) : null}
    </View>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onValueChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 44,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: "500",
            fontFamily: FONT.medium,
          }}
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
        >
          {hint}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: t.accent, false: t.border }}
        thumbColor={t.surface}
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={{ checked: value }}
      />
    </View>
  );
}

function Notice({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {text}
      </Text>
    </View>
  );
}
