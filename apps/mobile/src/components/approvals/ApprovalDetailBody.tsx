/**
 * ApprovalDetailBody — everything an approver needs BEFORE committing an
 * irreversible, audit-logged decision.
 *
 * The queue card is a poll up to 60 seconds old with notes clipped to two
 * lines. This view re-asks the server on open (so a teammate's decision
 * between list-load and open is visible), shows the full request, the
 * decision trail for a resolved row, and — for an AI-initiated request —
 * the agent's own reasoning.
 *
 * NOTE ON METADATA: the Go Approval struct carries no `metadata` field
 * (apps/api/internal/approvals/approvals.go). What it does carry, and what
 * this renders, is the provenance an auditor actually asks for:
 * contentHash (the anti "approve benign, then edit" fingerprint),
 * consumedAt, decidedAt/decidedByUserId, and the requesting API key.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import type {
  Approval,
  ApprovalAgentRun,
  ApprovalResourceContext,
} from "@/hooks/useApprovals";
import { dateTime, plural, truncateMiddle } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { statusTone } from "./ApprovalRow";
import {
  approvalRowNotices,
  expiryHint,
  isApprovalExpired,
  requestedAtLine,
  resourceLabel,
} from "./approvalPresentation";

export interface ApprovalDetailBodyProps {
  approval: Approval;
  context: ApprovalResourceContext;
  agentRun: ApprovalAgentRun | null;
  agentRunLoading: boolean;
  currentUserId: string | null;
  now: number;
}

export function ApprovalDetailBody({
  approval: a,
  context,
  agentRun,
  agentRunLoading,
  currentUserId,
  now,
}: ApprovalDetailBodyProps) {
  const { t } = useTheme();
  const typeLabel = resourceLabel(a.resourceType);
  const isPending = a.status === "pending";
  const isExpired = isApprovalExpired(a.expiresAt, now);
  const isOwnRequest = Boolean(
    currentUserId && a.requestedByUserId && a.requestedByUserId === currentUserId,
  );
  const expiry = isPending ? expiryHint(a.expiresAt, now) : "";

  return (
    <View style={{ gap: 14 }}>
      <ApprovalDetailHeader
        a={a}
        context={context}
        isPending={isPending}
        isExpired={isExpired}
        isOwnRequest={isOwnRequest}
        typeLabel={typeLabel}
        expiry={expiry}
        t={t}
      />

      {a.notes ? (
        <Section title="Request notes">
          <Text
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontFamily: FONT.regular,
            }}
            {...typeCap("callout")}
          >
            {a.notes}
          </Text>
        </Section>
      ) : null}

      <Section title="Request">
        <Row
          label="Requested by"
          value={
            a.requestedByActorLabel ||
            (a.requestedByActorType ? `via ${a.requestedByActorType}` : "unknown")
          }
        />
        <Row label="Requested" value={requestedAtLine(a.requestedAt, now) || "—"} />
        <Row label="Expires" value={dateTime(a.expiresAt)} />
        <Row label="Resource" value={`${a.resourceType} · ${a.resourceId}`} mono />
        {a.requestedByApiKeyId ? (
          <Row label="API key" value={truncateMiddle(a.requestedByApiKeyId, 20)} mono />
        ) : null}
      </Section>

      {!isPending ? (
        <Section title="Decision trail">
          <Row label="Outcome" value={a.status} />
          <Row label="Decided" value={a.decidedAt ? dateTime(a.decidedAt) : "—"} />
          <Row
            label="Decided by"
            value={
              a.decidedByUserId
                ? a.decidedByUserId === currentUserId
                  ? "You"
                  : truncateMiddle(a.decidedByUserId, 20)
                : "—"
            }
            mono={Boolean(a.decidedByUserId) && a.decidedByUserId !== currentUserId}
          />
          {a.consumedAt ? (
            <Row label="Action fired" value={dateTime(a.consumedAt)} />
          ) : null}
        </Section>
      ) : null}

      {a.contentHash ? (
        <Section title="Integrity">
          <Row
            label="Content hash"
            value={truncateMiddle(a.contentHash, 24)}
            mono
          />
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              marginTop: 6,
              fontFamily: FONT.regular,
            }}
          >
            The server re-checks this fingerprint when the approved action
            runs, so content edited after approval is refused rather than
            sent.
          </Text>
        </Section>
      ) : null}

      {a.requestedByActorType === "agent" ? (
        <Section title="Agent reasoning">
          {agentRunLoading ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              Loading the agent run…
            </Text>
          ) : agentRun ? (
            <View style={{ gap: 8 }}>
              {agentRun.status ? (
                <Row label="Run status" value={agentRun.status} />
              ) : null}
              {agentRun.reasoning ? (
                <Text
                  style={{
                    color: t.fg,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                  }}
                  {...typeCap("bodySmall")}
                >
                  {agentRun.reasoning}
                </Text>
              ) : (
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                  }}
                >
                  This run recorded no rationale.
                </Text>
              )}
              {agentRun.error ? (
                <Text
                  {...typeCap("label")}
                  style={{
                    color: t.danger,
                    ...typeStyle("label"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {agentRun.error}
                </Text>
              ) : null}
            </View>
          ) : (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              No agent run is linked to this request. Treat the requester
              label as the only provenance.
            </Text>
          )}
        </Section>
      ) : null}
    </View>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 6,
      }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 2,
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}
    >
      <Text
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          width: 104,
          fontFamily: FONT.regular,
        }}
        {...typeCap("label")}
      >
        {label}
      </Text>
      <Text
        style={{
          color: t.fg,
          ...typeStyle(mono ? "mono" : "label"),
          flex: 1,
          fontFamily: mono ? "Menlo" : FONT.regular,
        }}
        {...typeCap(mono ? "mono" : "label")}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * The identity block at the top of an approval: status pills, what is being
 * approved, and how long is left to decide.
 *
 * Split out because it carries most of this screen's branching — five
 * independent conditionals (agent-initiated, each row notice, an expiry that
 * only exists while pending, an optional context title, a subtitle assembled
 * from up to four optional parts) — and that pushed ApprovalDetailBody past
 * the complexity ceiling. Extracting it was the alternative to recording a new
 * debt allowance for a file written this week.
 */
function ApprovalDetailHeader({
  a,
  context,
  isPending,
  isExpired,
  isOwnRequest,
  typeLabel,
  expiry,
  t,
}: {
  a: ApprovalDetailBodyProps["approval"];
  context: ApprovalDetailBodyProps["context"];
  isPending: boolean;
  isExpired: boolean;
  isOwnRequest: boolean;
  typeLabel: string;
  expiry: string;
  t: ThemeTokens;
}) {
  const notices = approvalRowNotices({ isPending, isExpired, isOwnRequest });
  return (
      <View style={{ gap: 6 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          <Pill label={a.status} tone={statusTone(a.status)} />
          {a.requestedByActorType === "agent" ? (
            <Pill label="AI-initiated" tone="info" />
          ) : null}
          {notices.map((n) => (
            <Pill key={n.key} label={n.label} tone={n.tone} />
          ))}
        </View>
        <Text
          style={{
            color: t.fg,
            ...typeStyle("title"),
            fontWeight: "700",
            fontFamily: FONT.display,
          }}
          {...typeCap("title")}
        >
          {context.title ?? typeLabel}
        </Text>
        <Text
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
          {...typeCap("bodySmall")}
        >
          {[
            typeLabel,
            context.subtitle,
            typeof context.recipients === "number" && context.recipients > 0
              ? plural(context.recipients, "recipient")
              : null,
            context.status,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        {expiry ? (
          <Text
            {...typeCap("label")}
            style={{
              color: isExpired ? t.danger : t.warning,
              ...typeStyle("label"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {expiry}
          </Text>
        ) : null}
      </View>
  );
}
