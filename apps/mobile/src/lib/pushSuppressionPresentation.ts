/** Truthful Route43 registry labels and bounded-fingerprint presentation. */
import type { PushPlatform, PushSuppressionReason } from "./pushSuppressions";

const FINGERPRINT = /^[0-9a-f]{16}$/u;

const PLATFORM_LABELS: Record<PushPlatform, string> = {
  apns: "iOS / APNs",
  fcm: "Android / FCM",
  web: "Customer web push",
};

const REASON_LABELS: Record<PushSuppressionReason, string> = {
  manual: "Manual registry hold",
  unregistered: "Token unregistered",
  expired: "Token expired",
  complaint: "Complaint authority",
  user_opt_out: "User opt-out authority",
};

const REASON_HINTS: Record<PushSuppressionReason, string> = {
  manual: "A workspace admin added this reversible registry authority.",
  unregistered:
    "Provider authority is locked; automatic provider feedback is not available yet.",
  expired:
    "Provider authority is locked; automatic provider feedback is not available yet.",
  complaint:
    "Complaint authority is locked and requires reviewed reconciliation.",
  user_opt_out: "User opt-out authority is locked and cannot be removed here.",
};

export const PUSH_PLATFORM_FILTERS = [
  {
    key: "all",
    label: "All devices",
    accessibilityLabel: "Show all customer push platforms",
  },
  {
    key: "apns",
    label: PLATFORM_LABELS.apns,
    accessibilityLabel: `Show ${PLATFORM_LABELS.apns} registry entries only`,
  },
  {
    key: "fcm",
    label: PLATFORM_LABELS.fcm,
    accessibilityLabel: `Show ${PLATFORM_LABELS.fcm} registry entries only`,
  },
  {
    key: "web",
    label: PLATFORM_LABELS.web,
    accessibilityLabel: `Show ${PLATFORM_LABELS.web} registry entries only`,
  },
] as const;

export function isPushSuppressionFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT.test(value);
}

export function pushPlatformLabel(value: string | undefined): string {
  return (
    PLATFORM_LABELS[value as PushPlatform] ?? "Unknown customer push platform"
  );
}

export function pushReasonLabel(value: string | undefined): string {
  return REASON_LABELS[value as PushSuppressionReason] ?? "Unknown authority";
}

export function pushReasonHint(value: string | undefined): string {
  return REASON_HINTS[value as PushSuppressionReason] ?? "";
}

export function pushReasonTone(
  value: string | undefined,
): "danger" | "warning" | "neutral" {
  if (value === "complaint") return "danger";
  if (value === "user_opt_out" || value === "manual") return "warning";
  return "neutral";
}

export function deviceHandle(fingerprint: string | undefined): string {
  return isPushSuppressionFingerprint(fingerprint)
    ? fingerprint
    : "Unknown device fingerprint";
}

export function deviceHandleSpoken(fingerprint: string | undefined): string {
  return isPushSuppressionFingerprint(fingerprint)
    ? `Device fingerprint ${fingerprint.split("").join(" ")}`
    : "Unknown device fingerprint";
}

export function pushUnsuppressCopy(): {
  title: string;
  message: string;
  confirmLabel: string;
} {
  return {
    title: "Remove this manual registry hold?",
    message:
      "This removes only this reversible manual authority. It does not clear provider, complaint, or user opt-out authority, and customer push delivery remains release-held.",
    confirmLabel: "Remove manual hold",
  };
}
