/**
 * PrivacyRequestActionSheet — the four DSAR lifecycle levers, on a phone.
 *
 * These endpoints have shipped since the privacy workflow landed and mobile
 * called none of them: a request could be READ from a phone but never moved.
 * "Place a legal hold on this request" and "deny it, here is counsel's reason"
 * are precisely the decisions that arrive by phone call while nobody is at a
 * desk.
 *
 * Two rules the sheet keeps:
 *
 *  1. ONLY LEGAL TRANSITIONS ARE OFFERED. `allowedActions` mirrors the Go
 *     handlers' status guards, so a fulfilled request is not offered a Deny
 *     button that can only return 409 invalid_status.
 *  2. A REASON IS NEVER OPTIONAL WHERE THE SERVER DEMANDS ONE. hold / deny /
 *     appeal all 400 on an empty reason; the confirm button stays disabled
 *     until one is typed, rather than firing a request that cannot succeed.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import {
  appealPrivacyRequest,
  clearPrivacyLegalHold,
  denyPrivacyRequest,
  issuePrivacyVerification,
  setPrivacyLegalHold,
  type PrivacyRegion,
} from "@/api/settingsExtras";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { settingsInputStyle } from "@/components/settings/FormControls";
import { formatPrivacyLabel } from "@/components/settings/SettingsScreenPrimitives";
import { useToast } from "@/components/Toast";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  PRIVACY_ACTION_LABELS,
  actionIsDestructive,
  actionRequiresReason,
  allowedActions,
  type PrivacyAction,
  type PrivacyQueueRow,
} from "@/lib/privacyQueue";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function normalizeRegion(value: string): PrivacyRegion {
  const upper = (value ?? "").trim().toUpperCase();
  return upper === "GDPR" || upper === "CCPA" ? upper : "OTHER";
}

async function runAction(
  action: PrivacyAction,
  row: PrivacyQueueRow,
  reason: string,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const id = row.request_id;
  switch (action) {
    case "verify": {
      const to = row.subject_email?.trim() ?? "";
      const res = await issuePrivacyVerification(id, to);
      if (res.error) return { ok: false, message: res.error.message };
      return {
        ok: true,
        message: to
          ? `Verification sent to ${to}. It expires with the token, not with the deadline.`
          : "Verification token issued. No subject address was on file, so send it manually.",
      };
    }
    case "deny": {
      const res = await denyPrivacyRequest(id, reason);
      if (res.error) return { ok: false, message: res.error.message };
      return { ok: true, message: "Request denied and the reason recorded." };
    }
    case "hold": {
      const res = await setPrivacyLegalHold(id, reason);
      if (res.error) return { ok: false, message: res.error.message };
      return { ok: true, message: "Legal hold applied. The clock is paused." };
    }
    case "clear_hold": {
      const res = await clearPrivacyLegalHold(id);
      if (res.error) return { ok: false, message: res.error.message };
      return { ok: true, message: "Hold released. The clock is running again." };
    }
    case "appeal": {
      const res = await appealPrivacyRequest(
        id,
        reason,
        normalizeRegion(row.region),
      );
      if (res.error) return { ok: false, message: res.error.message };
      return {
        ok: true,
        message: `Appeal recorded as ${res.data?.appeal_request_id ?? "a linked request"}.`,
      };
    }
  }
}

export function PrivacyRequestActionSheet({
  request,
  onClose,
  onCompleted,
}: {
  request: PrivacyQueueRow | null;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const [pending, setPending] = useState<PrivacyAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  // A reason typed for one request must never be carried into another one —
  // "manifestly unfounded" attached to the wrong subject is a compliance
  // incident, not a UI glitch.
  useEffect(() => {
    setPending(null);
    setReason("");
  }, [request?.request_id]);

  if (!request) {
    return (
      <KeyboardFormSheet
        visible={false}
        onClose={onClose}
        accessibilityLabel="Privacy request actions"
      >
        <View />
      </KeyboardFormSheet>
    );
  }

  const actions = allowedActions(request);
  const needsReason = pending !== null && actionRequiresReason(pending);
  const canSubmit = pending !== null && (!needsReason || reason.trim() !== "");

  const submit = async () => {
    if (!pending || busy || !canSubmit) return;
    setBusy(true);
    try {
      const outcome = await runAction(pending, request, reason.trim());
      if (!outcome.ok) {
        haptics.error();
        toast({ kind: "error", message: outcome.message });
        return;
      }
      haptics.success();
      toast({ kind: "success", message: outcome.message });
      onCompleted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardFormSheet
      visible
      onClose={onClose}
      accessibilityLabel={`Actions for ${formatPrivacyLabel(request.type)}`}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{ color: t.fg, fontFamily: FONT.bold, ...typeStyle("title") }}
      >
        {formatPrivacyLabel(request.type)}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
          marginTop: 4,
          marginBottom: 16,
        }}
      >
        {request.subject_email?.trim() || "No subject address on file"} ·{" "}
        {formatPrivacyLabel(request.status)} ·{" "}
        {formatPrivacyLabel(request.region)}
      </Text>

      <View style={{ gap: 8 }}>
        {actions.map((action) => {
          const selected = pending === action;
          return (
            <Pressable
              key={action}
              onPress={() => {
                haptics.tap();
                setPending(selected ? null : action);
                if (!selected) setReason("");
              }}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={PRIVACY_ACTION_LABELS[action]}
              style={{
                minHeight: 44,
                justifyContent: "center",
                paddingHorizontal: 14,
                borderRadius: 10,
                borderWidth: selected ? 2 : 1,
                borderColor: selected
                  ? actionIsDestructive(action)
                    ? t.danger
                    : t.accent
                  : t.border,
                backgroundColor: t.surface,
              }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: actionIsDestructive(action) ? t.danger : t.fg,
                  fontFamily: selected ? FONT.semibold : FONT.regular,
                  ...typeStyle("callout"),
                }}
              >
                {PRIVACY_ACTION_LABELS[action]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {needsReason ? (
        <View style={{ marginTop: 16 }}>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.semibold,
              ...typeStyle("caption"),
              textTransform: "uppercase",
              letterSpacing: 0.5,
              marginBottom: 4,
            }}
          >
            Reason (required, recorded in the audit log)
          </Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            multiline
            placeholder="e.g. identity could not be verified after two attempts"
            placeholderTextColor={t.fgSubtle}
            accessibilityLabel="Reason for this action"
            accessibilityHint="The server rejects this action without a reason"
            {...typeCap("body")}
            style={[
              settingsInputStyle(t),
              { minHeight: 88, textAlignVertical: "top" },
            ]}
          />
        </View>
      ) : null}

      <View style={{ marginTop: 20, gap: 8 }}>
        <Pressable
          onPress={() => void submit()}
          disabled={!canSubmit || busy}
          accessibilityRole="button"
          accessibilityLabel={
            pending
              ? `Confirm: ${PRIVACY_ACTION_LABELS[pending]}`
              : "Choose an action first"
          }
          accessibilityState={{ disabled: !canSubmit || busy }}
          style={{
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            backgroundColor:
              pending && actionIsDestructive(pending) ? t.danger : t.accent,
            opacity: canSubmit && !busy ? 1 : 0.5,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.accentFg,
              fontFamily: FONT.bold,
              ...typeStyle("body"),
            }}
          >
            {busy ? "Working…" : "Confirm"}
          </Text>
        </Pressable>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close without changing this request"
          style={{
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              fontFamily: FONT.regular,
              ...typeStyle("body"),
            }}
          >
            Cancel
          </Text>
        </Pressable>
      </View>
    </KeyboardFormSheet>
  );
}
