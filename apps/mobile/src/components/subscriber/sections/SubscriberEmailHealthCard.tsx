import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";

import {
  getEmailHealth,
  type EmailHealth,
  type EmailHealthGrade,
  type EmailHealthRecommendation,
} from "@/api/emailHealth";
import {
  Card,
  Label,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import { VendorVerifyAction } from "@/components/subscriber/sections/VendorVerifyAction";
import { FONT } from "@/lib/fonts";
import { date, relativeTime } from "@/lib/format";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { subscriberDetailKey } from "@/lib/subscriberQueryKeys";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const gradeCopy: Record<EmailHealthGrade, { label: string; detail: string }> = {
  A: {
    label: "Recently validated",
    detail: "Validated within the last 30 days.",
  },
  B: {
    label: "Positive activity",
    detail:
      "A recent first-party delivery, human-classified click, or human reply supports this address.",
  },
  C: {
    label: "Catch-all",
    detail: "The domain receives mail; the exact mailbox is uncertain.",
  },
  D: {
    label: "Negative activity",
    detail:
      "A hard, soft, or unclassified bounce in the last 30 days has not been superseded by newer first-party positive activity.",
  },
  F: {
    label: "Invalid or blocked",
    detail:
      "An invalid, spam-trap, abuse, or do-not-mail result, a complaint, or an active consent/suppression stop applies.",
  },
  U: {
    label: "Not enough evidence",
    detail: "No decisive current signal is available.",
  },
};

const recommendationCopy: Record<EmailHealthRecommendation, string> = {
  send: "Send",
  caution: "Review before sending",
  do_not_send: "Do not send",
  blocked: "Blocked from sending",
};

export function healthReasonLabel(code: string): string {
  const known: Record<string, string> = {
    verification_valid_30d: "Validated in the last 30 days",
    verification_catch_all: "Catch-all mailbox",
    verification_invalid: "Verifier reported invalid",
    verification_spamtrap: "Spam-trap signal",
    verification_abuse: "Abuse-risk signal",
    verification_do_not_mail: "Verifier marked do not mail",
    verification_stale: "Validation is older than 30 days",
    no_decisive_evidence: "No decisive current signal",
    open_not_high_confidence: "Open activity alone is not conclusive",
    active_send_hard_stop: "Active consent or suppression stop",
    suppression_hard_bounce: "Active hard-bounce suppression",
    suppression_soft_bounce: "Active soft-bounce suppression",
    suppression_soft_bounce_threshold: "Active soft-bounce suppression",
    consent_unsubscribed: "Currently unsubscribed",
    consent_not_proven: "Consent not currently proven",
    address_suppressed: "Address currently suppressed",
    health_evidence_unavailable: "Health evidence is temporarily unavailable",
  };
  return (
    known[code] ??
    code
      .replace(/^(?:event|suppression|consent|evidence)_/u, "")
      .replace(/[_-]+/gu, " ")
      .replace(/^./u, (first) => first.toUpperCase())
  );
}

function errorStatus(error: unknown): number {
  if (!error || typeof error !== "object" || !("status" in error)) return 0;
  return Number((error as { status?: unknown }).status) || 0;
}

export function SubscriberEmailHealthCard({
  email,
  subscriberId,
}: {
  email: string;
  subscriberId: string;
}) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const normalized = email.trim().toLowerCase();
  const health = useQuery({
    // No recipient PII in the key. Existing subscriber mutation prefixes now
    // invalidate health together with the profile that supplied the email.
    queryKey: [
      ...subscriberDetailKey(gate.tenantId, subscriberId),
      "email-health",
      gate.userId,
      gate.effectiveRole,
    ],
    queryFn: () => getEmailHealth(normalized),
    enabled:
      gate.enabled && Boolean(normalized && gate.tenantId && subscriberId),
    staleTime: 10_000,
    retry: (count, error) =>
      ![404, 405, 501].includes(errorStatus(error)) && count < 2,
  });

  if ([404, 405, 501].includes(errorStatus(health.error))) return null;
  if (!gate.enabled && !health.data) return null;

  return (
    <Card
      accessibilityLabel="Email health"
      accessibilityLiveRegion="polite"
      style={{ marginTop: 12 }}
    >
      <Label>Email health</Label>
      {health.isPending && !health.data ? (
        <Text
          accessibilityRole="text"
          {...typeCap("body")}
          style={{ color: t.fgMuted, ...typeStyle("body"), marginTop: 8 }}
        >
          Resolving validation, activity, consent, and suppression evidence…
        </Text>
      ) : health.error || !health.data ? (
        <View style={{ marginTop: 8 }}>
          <Text
            accessibilityRole="alert"
            {...typeCap("body")}
            style={{ color: t.danger, ...typeStyle("body") }}
          >
            Health evidence could not be verified. No send recommendation is
            shown.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry email health"
            onPress={() => void health.refetch()}
            android_ripple={{ color: t.borderSubtle }}
            // NativeWind v4: static style object only. The function form here
            // bought `opacity: pressed ? 0.7 : 1` and silently dropped every
            // other property with it — this button rendered with no border,
            // radius, padding or top margin. Ripple carries the press
            // feedback instead, matching AuditFeedCard and the rest of the
            // stack.
            style={{
              alignSelf: "flex-start",
              marginTop: 10,
              borderColor: t.border,
              borderWidth: 1,
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 8,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{ color: t.fg, fontFamily: FONT.semibold }}
            >
              Retry
            </Text>
          </Pressable>
        </View>
      ) : (
        <ResolvedHealth health={health.data} />
      )}
      {/* Derived evidence can be old; this forces a live vendor check on the
          same address. It spends a provider credit, so it is confirmed, never
          automatic, and re-reads the health above on success. */}
      <VendorVerifyAction
        email={normalized}
        onVerified={() => void health.refetch()}
      />
    </Card>
  );
}

function ResolvedHealth({ health }: { health: EmailHealth }) {
  const { t } = useTheme();
  const tone =
    health.grade === "A" || health.grade === "B"
      ? t.success
      : health.grade === "C" || health.grade === "U"
        ? t.warning
        : t.danger;
  const reasons = health.reason_codes.slice(0, 4);
  return (
    <View style={{ marginTop: 8 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <View
          accessible
          accessibilityLabel={`Email health grade ${health.grade}`}
          style={{
            borderColor: tone,
            borderWidth: 1,
            borderRadius: 999,
            paddingHorizontal: 9,
            paddingVertical: 3,
          }}
        >
          <Text
            {...typeCap("badge")}
            style={{
              color: tone,
              ...typeStyle("badge"),
              fontFamily: FONT.semibold,
            }}
          >
            Grade {health.grade}
          </Text>
        </View>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
          }}
        >
          {gradeCopy[health.grade].label}
        </Text>
      </View>
      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.semibold,
          marginTop: 10,
        }}
      >
        {health.evidence_complete
          ? recommendationCopy[health.recommendation]
          : "Sending paused — evidence unavailable"}
      </Text>
      <Text
        {...typeCap("body")}
        style={{ color: t.fgMuted, ...typeStyle("body"), marginTop: 4 }}
      >
        {health.evidence_complete
          ? gradeCopy[health.grade].detail
          : "Consent and suppression evidence could not be loaded, so this address remains ineligible until health can be recomputed."}
        {health.hard_stop
          ? " An active hard stop takes precedence over every positive signal."
          : ""}
      </Text>
      {reasons.length > 0 ? (
        <View
          accessibilityLabel="Email health reasons"
          style={{ marginTop: 8, gap: 4 }}
        >
          {reasons.map((reason) => (
            <Text
              key={reason}
              {...typeCap("caption")}
              style={{ color: t.fgMuted, ...typeStyle("caption") }}
            >
              • {healthReasonLabel(reason)}
            </Text>
          ))}
          {health.reason_codes.length > reasons.length ? (
            <Text
              {...typeCap("caption")}
              style={{ color: t.fgSubtle, ...typeStyle("caption") }}
            >
              +{health.reason_codes.length - reasons.length} more evidence
              reasons
            </Text>
          ) : null}
        </View>
      ) : null}
      <Text
        {...typeCap("caption")}
        style={{ color: t.fgSubtle, ...typeStyle("caption"), marginTop: 9 }}
      >
        {health.grade === "A" &&
        health.status === "valid" &&
        health.checked_at
          ? `Validated ${date(health.checked_at)} · `
          : ""}
        {health.evidence_at
          ? `Latest evidence ${relativeTime(health.evidence_at)} · `
          : ""}
        Model {health.model_version} · computed{" "}
        {relativeTime(health.computed_at)}
      </Text>
    </View>
  );
}
