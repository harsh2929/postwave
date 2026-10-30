/**
 * WebhookAlertPrefsSection — when Moosewave should page you about a failing
 * webhook.
 *
 * Mobile shipped the outbound-webhook editor (create / edit / delete plus the
 * canned signed test) before this alert control. On a phone, the alert is what
 * brings an operator back to inspect or repair that configured endpoint.
 * GET/PUT /api/v1/webhooks/alert-prefs has always been there.
 *
 * PUT is a FULL replace — every threshold field is required — so this holds the
 * complete object and sends the merged value, and the numeric thresholds are
 * clamped to the server's documented bounds so a typo produces a valid request
 * rather than a 422.
 */
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import {
  clampFailureRate,
  clampLatencyMs,
  getWebhookAlertPrefs,
  putWebhookAlertPrefs,
  type WebhookAlertPrefs,
} from "@/api/settingsExtras";
import {
  SettingsSwitchRow,
  SettingsTextInput,
} from "@/components/settings/FormControls";
import { Card } from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type LoadState = "loading" | "ready" | "unavailable" | "failed";

export function WebhookAlertPrefsSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const [state, setState] = useState<LoadState>("loading");
  const [prefs, setPrefs] = useState<WebhookAlertPrefs | null>(null);
  const [latencyText, setLatencyText] = useState("");
  const [ratePct, setRatePct] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!gate.enabled || !gate.tenantId) {
      setState("failed");
      return;
    }
    setState("loading");
    void getWebhookAlertPrefs().then((res) => {
      if (cancelled) return;
      if (res.error || !res.data) {
        setState(
          res.error?.status === 404 || res.error?.status === 501
            ? "unavailable"
            : "failed",
        );
        return;
      }
      setPrefs(res.data);
      setLatencyText(String(res.data.latency_ms));
      setRatePct(String(res.data.failure_rate_pct));
      setState("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [gate.enabled, gate.tenantId]);

  const commit = (next: WebhookAlertPrefs) => {
    const previous = prefs;
    setPrefs(next);
    void putWebhookAlertPrefs(next).then((res) => {
      if (res.error) {
        setPrefs(previous);
        if (previous) {
          setLatencyText(String(previous.latency_ms));
          setRatePct(String(previous.failure_rate_pct));
        }
        toast({ kind: "error", message: "Couldn't save webhook alerts." });
      }
    });
  };

  if (state === "loading") {
    return (
      <Card>
        <SkeletonList rows={2} lines={2} label="Loading webhook alerts" />
      </Card>
    );
  }
  if (state !== "ready" || !prefs) {
    return (
      <Card>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {state === "unavailable"
            ? "Webhook alerts are unavailable on this deployment."
            : "Couldn't load webhook alert preferences."}
        </Text>
      </Card>
    );
  }

  return (
    <Card>
      <View style={{ gap: 14 }}>
        <SettingsSwitchRow
          label="Alert when a destination is auto-paused"
          hint="The outbound worker disables a destination after repeated failures."
          value={prefs.notify_auto_disabled}
          onValueChange={(v) => commit({ ...prefs, notify_auto_disabled: v })}
        />
        <SettingsSwitchRow
          label="Alert on failure rate"
          hint="Notify once the share of failed deliveries crosses the threshold."
          value={prefs.notify_failure_rate}
          onValueChange={(v) => commit({ ...prefs, notify_failure_rate: v })}
        />
        {prefs.notify_failure_rate ? (
          <SettingsTextInput
            label="Failure rate threshold (%)"
            hint="Between 1 and 100."
            value={ratePct}
            onChangeText={setRatePct}
            onBlur={() => {
              const clamped = clampFailureRate(Number(ratePct));
              setRatePct(String(clamped));
              if (clamped !== prefs.failure_rate_pct) {
                commit({ ...prefs, failure_rate_pct: clamped });
              }
            }}
            keyboardType="number-pad"
            returnKeyType="done"
          />
        ) : null}
        <SettingsSwitchRow
          label="Alert on latency"
          hint="Notify when deliveries take longer than the threshold."
          value={prefs.notify_latency}
          onValueChange={(v) => commit({ ...prefs, notify_latency: v })}
        />
        {prefs.notify_latency ? (
          <SettingsTextInput
            label="Latency threshold (ms)"
            hint="Between 1 and 600000 (10 minutes)."
            value={latencyText}
            onChangeText={setLatencyText}
            onBlur={() => {
              const clamped = clampLatencyMs(Number(latencyText));
              setLatencyText(String(clamped));
              if (clamped !== prefs.latency_ms) {
                commit({ ...prefs, latency_ms: clamped });
              }
            }}
            keyboardType="number-pad"
            returnKeyType="done"
          />
        ) : null}
      </View>
    </Card>
  );
}
