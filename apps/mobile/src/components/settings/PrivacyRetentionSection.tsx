/**
 * PrivacyRetentionSection — three numeric inputs for retention windows
 * (audit log / email event / unsubscribed subscriber). Mirrors the
 * desktop's privacy panel.
 *
 * Each input mirrors the backend ranges in
 * apps/api/internal/settings/privacy.go so invalid values are caught before
 * the request hits the API.
 *
 * Save commits all three at once because the API accepts a partial
 * body; only changed fields are sent.
 *
 * Outcomes — saved, refused, out of range — are toasts: the Settings
 * screen's after-the-action channel (Toast.tsx), not a modal to dismiss.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
  getRetentionPolicy,
  patchRetentionPolicy,
  type RetentionPolicy,
} from "@/api/settings";
import { SettingsTextInput } from "@/components/settings/FormControls";
import { ProvenanceLine } from "@/components/settings/ProvenanceLine";
import { useToast } from "@/components/Toast";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

interface Draft {
  audit_log_retention_days: string;
  email_event_retention_days: string;
  unsubscribed_subscriber_retention_days: string;
}

const LIMITS = {
  audit_log_retention_days: { min: 7, max: 2555 },
  email_event_retention_days: { min: 30, max: 2555 },
  unsubscribed_subscriber_retention_days: { min: 7, max: 3650 },
} as const;

function fromServer(p: RetentionPolicy): Draft {
  return {
    audit_log_retention_days: String(p.audit_log_retention_days),
    email_event_retention_days: String(p.email_event_retention_days),
    unsubscribed_subscriber_retention_days: String(
      p.unsubscribed_subscriber_retention_days,
    ),
  };
}

function toNumberOrNull(
  s: string,
  key: keyof typeof LIMITS,
): number | null {
  if (!s) return null;
  const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
  const limit = LIMITS[key];
  if (!Number.isFinite(n) || n < limit.min || n > limit.max) return null;
  return n;
}

export function PrivacyRetentionSection() {
  const { t } = useTheme();
  const { toast } = useToast();
  const [orig, setOrig] = useState<RetentionPolicy | null>(null);
  const [draft, setDraft] = useState<Draft>({
    audit_log_retention_days: "",
    email_event_retention_days: "",
    unsubscribed_subscriber_retention_days: "",
  });
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getRetentionPolicy();
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        if (res.error.status === 404 || res.error.status === 501) {
          setUnavailable(true);
        }
        return;
      }
      if (res.data) {
        setOrig(res.data);
        setDraft(fromServer(res.data));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = async () => {
    if (!orig) return;
    const patch: Parameters<typeof patchRetentionPolicy>[0] = {};
    const next1 = toNumberOrNull(
      draft.audit_log_retention_days,
      "audit_log_retention_days",
    );
    const next2 = toNumberOrNull(
      draft.email_event_retention_days,
      "email_event_retention_days",
    );
    const next3 = toNumberOrNull(
      draft.unsubscribed_subscriber_retention_days,
      "unsubscribed_subscriber_retention_days",
    );
    if (next1 == null || next2 == null || next3 == null) {
      toast({
        kind: "error",
        message:
          "Audit logs must be 7-2555 days, email events 30-2555 days, and unsubscribed subscribers 7-3650 days.",
      });
      return;
    }
    if (next1 !== orig.audit_log_retention_days) {
      patch.audit_log_retention_days = next1;
    }
    if (next2 !== orig.email_event_retention_days) {
      patch.email_event_retention_days = next2;
    }
    if (next3 !== orig.unsubscribed_subscriber_retention_days) {
      patch.unsubscribed_subscriber_retention_days = next3;
    }
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    const res = await patchRetentionPolicy(patch);
    setSaving(false);
    if (res.error || !res.data) {
      const detail = res.error?.message ?? "";
      toast({
        kind: "error",
        message: `Couldn't save the retention policy. ${detail}`.trim(),
      });
      return;
    }
    setOrig(res.data);
    setDraft(fromServer(res.data));
    toast({ kind: "success", message: "Retention policy updated." });
  };

  const dirty =
    orig != null &&
    (toNumberOrNull(draft.audit_log_retention_days, "audit_log_retention_days") !==
      orig.audit_log_retention_days ||
      toNumberOrNull(draft.email_event_retention_days, "email_event_retention_days") !==
        orig.email_event_retention_days ||
      toNumberOrNull(
        draft.unsubscribed_subscriber_retention_days,
        "unsubscribed_subscriber_retention_days",
      ) !==
        orig.unsubscribed_subscriber_retention_days);

  if (unavailable) {
    return <Notice text="Retention policy unavailable on this deployment." />;
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
        Loading retention policy…
      </Text>
    );
  }
  if (!orig) {
    return <Notice text="Couldn't load retention policy." />;
  }

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 16,
        padding: 14,
        gap: 10,
      }}
    >
      <SettingsTextInput
        label="Audit log (days)"
        hint="Workspace-wide audit-log retention. Older entries are purged nightly."
        value={draft.audit_log_retention_days}
        onChangeText={(v) =>
          setDraft((d) => ({
            ...d,
            audit_log_retention_days: v.replace(/[^0-9]/g, ""),
          }))
        }
        keyboardType="number-pad"
      />
      <SettingsTextInput
        label="Email events (days)"
        hint="Open / click / bounce event retention. Affects campaign reports."
        value={draft.email_event_retention_days}
        onChangeText={(v) =>
          setDraft((d) => ({
            ...d,
            email_event_retention_days: v.replace(/[^0-9]/g, ""),
          }))
        }
        keyboardType="number-pad"
      />
      <SettingsTextInput
        label="Unsubscribed subscriber (days)"
        hint="How long to retain unsubscribed subscriber records before anonymising."
        value={draft.unsubscribed_subscriber_retention_days}
        onChangeText={(v) =>
          setDraft((d) => ({
            ...d,
            unsubscribed_subscriber_retention_days: v.replace(/[^0-9]/g, ""),
          }))
        }
        keyboardType="number-pad"
      />
      <Pressable
        onPress={() => void onSave()}
        disabled={!dirty || saving}
        accessibilityRole="button"
        accessibilityLabel="Save retention policy"
        accessibilityState={{ disabled: !dirty || saving, busy: saving }}
        style={{
          marginTop: 4,
          paddingVertical: 12,
          borderRadius: 10,
          backgroundColor: t.accent,
          alignItems: "center",
          opacity: !dirty || saving ? 0.5 : 1,
          minHeight: 44,
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.accentFg,
            ...typeStyle("body"),
            fontWeight: "700",
            fontFamily: FONT.bold,
          }}
        >
          {saving ? "Saving…" : "Save changes"}
        </Text>
      </Pressable>
      {/* The payload has always carried updated_at / updated_by_user_id and
          this panel rendered neither — on a retention policy, "who shortened
          this and when" is a compliance question, not a nicety. */}
      <ProvenanceLine
        updatedAt={orig.updated_at}
        updatedByUserId={orig.updated_by_user_id}
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
