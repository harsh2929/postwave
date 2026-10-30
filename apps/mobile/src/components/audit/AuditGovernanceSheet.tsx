/**
 * AuditGovernanceSheet — the workspace-level audit governance verbs, one
 * sheet: the retention policy, auditor portal sessions, and (for admins) the
 * pending audit-access queue.
 *
 * Three capabilities desktop either ships or holds half-built, translated to
 * the phone idiom:
 *
 *  - RETENTION POLICY (GET viewer / PUT admin). Shown to every log reader,
 *    changeable by admins. SHORTENING the window is the data-destroying
 *    direction — older rows become eligible for the next purge — so a
 *    reduction gets the destructive confirm and a lengthening does not.
 *  - PORTAL SESSIONS: LIST + REVOKE, deliberately not MINT. The mint returns
 *    a bearer portal URL (lib/stoppingHalfPolicy: a starting half that hands
 *    back a credential stays off the phone) and desktop's own release note
 *    holds it. Revoking a session someone should not have is the archetypal
 *    away-from-desk act and can only remove authority.
 *  - ACCESS REQUESTS: awareness only. Granting audit scopes is a roles-screen
 *    operation; what the phone owes an admin is "someone is waiting", not a
 *    grant button that half-works.
 *
 * Every write is online-only and never queued (see hooks/useAuditGovernance).
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useConfirm } from "@/components/ConfirmSheet";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { useToast } from "@/components/Toast";
import {
  useAuditPortalSessions,
  useAuditRetention,
  useRevokeAuditPortalSession,
  useSetAuditRetention,
} from "@/hooks/useAuditGovernance";
import type { AuditAuthMode, AuditScopeSet } from "@/lib/auditForensics";
import {
  AUDIT_RETENTION_PRESETS,
  accessRequesterLabel,
  isPortalSessionRevocable,
  isRetentionReduction,
  portalRevokeAccess,
  portalSessionState,
  retentionPolicyWriteAccess,
  retentionSummaryLine,
  type AuditAccessRequest,
  type AuditPortalSession,
  type AuditRetentionPolicy,
} from "@/lib/auditGovernance";
import { forwardChevron } from "@/lib/direction";
import { dateTime, plural, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { AuditAction } from "./AuditAction";
import { SheetHeader } from "./AuditSheetParts";

export interface AuditGovernanceSheetProps {
  visible: boolean;
  onClose: () => void;
  scopes: AuditScopeSet | null | undefined;
  mode: AuditAuthMode;
  online: boolean;
  isAdmin: boolean;
  /** The admin awareness read, owned by the screen so its banner can count. */
  accessRequests: AuditAccessRequest[] | undefined;
  accessRequestsFailed: boolean;
}

/**
 * The screen-side entry: one modest row above the log, plus — for an admin
 * with a non-empty queue — the "someone is waiting" line. Both open the sheet.
 * The banner line comes from `accessRequestsBannerLine`, which is null on an
 * empty queue, so the loud half never renders on zero.
 */
export function AuditGovernanceStrip({
  bannerLine,
  onOpen,
}: {
  bannerLine: string | null;
  onOpen: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={
        bannerLine
          ? `${bannerLine} Opens audit governance.`
          : "Audit governance: retention policy, auditor sessions and access requests"
      }
      hitSlop={4}
      style={{ minHeight: 44, justifyContent: "center", marginBottom: 8, gap: 2 }}
    >
      {bannerLine ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("bodySmall")}
          style={{
            color: t.warning,
            fontFamily: FONT.semibold,
            ...typeStyle("bodySmall"),
          }}
        >
          {bannerLine}
        </Text>
      ) : null}
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
      >
        {`Governance: retention, auditor sessions, access requests ${forwardChevron()}`}
      </Text>
    </Pressable>
  );
}

export function AuditGovernanceSheet(props: AuditGovernanceSheetProps) {
  const { t } = useTheme();
  const retention = useAuditRetention(props.visible);
  const sessions = useAuditPortalSessions(props.visible);
  return (
    <ReducedMotionModal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        accessibilityLabel="Audit governance"
      >
        <SheetHeader title="Audit governance" onClose={props.onClose} />
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 20 }}
        >
          <RetentionSection
            policy={retention.data}
            loading={retention.isLoading}
            failed={retention.isError}
            scopes={props.scopes}
            mode={props.mode}
            online={props.online}
          />
          <PortalSessionsSection
            sessions={sessions.data}
            loading={sessions.isLoading}
            failed={sessions.isError}
            scopes={props.scopes}
            mode={props.mode}
            online={props.online}
          />
          {props.isAdmin ? (
            <AccessRequestsSection
              requests={props.accessRequests}
              failed={props.accessRequestsFailed}
            />
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function RetentionSection({
  policy,
  loading,
  failed,
  scopes,
  mode,
  online,
}: {
  policy: AuditRetentionPolicy | undefined;
  loading: boolean;
  failed: boolean;
  scopes: AuditScopeSet | null | undefined;
  mode: AuditAuthMode;
  online: boolean;
}) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const write = useSetAuditRetention();
  const access = retentionPolicyWriteAccess({ scopes, mode, online });

  const change = async (days: number | null, label: string) => {
    if (!policy) return;
    const reduction = days !== null && isRetentionReduction(policy, days);
    const ok = await confirm({
      title: days === null ? "Use the deployment default?" : `Keep audit events ${label}?`,
      message: reduction
        ? "This SHORTENS the retention window. Events older than the new window become eligible for the next purge, and a purged event cannot be recovered."
        : "This changes how long every audit event in the workspace is kept.",
      confirmLabel: days === null ? "Use default" : `Keep ${label}`,
      destructive: reduction,
      ...(reduction ? { consequence: "Older audit history will be purged." } : {}),
    });
    if (!ok) return;
    try {
      await write.mutateAsync(days);
      toast({ kind: "success", message: "Retention policy updated." });
    } catch (err) {
      toast({ kind: "error", message: retentionErrorMessage(err) });
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <SectionTitle text="Retention policy" />
      {loading ? <Muted text="Loading the retention policy…" /> : null}
      {failed ? (
        <Muted text="Couldn't load the retention policy. Pull the log to refresh and reopen this sheet." />
      ) : null}
      {policy ? <Muted text={retentionSummaryLine(policy)} /> : null}
      {policy && access.allowed ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {AUDIT_RETENTION_PRESETS.map((preset) => (
            <AuditAction
              key={preset.days}
              label={preset.label}
              hint={`Sets the workspace audit retention window to ${preset.label}`}
              disabled={write.isPending || policy.retentionDays === preset.days}
              onPress={() => void change(preset.days, preset.label)}
            />
          ))}
          <AuditAction
            label="Default"
            hint="Removes the workspace override and returns to the deployment default"
            disabled={write.isPending || policy.retentionDays === null}
            onPress={() => void change(null, "the deployment default")}
          />
        </View>
      ) : null}
      {policy && !access.allowed && access.known && access.notice ? (
        <Muted text={access.notice} />
      ) : null}
    </View>
  );
}

function retentionErrorMessage(err: unknown): string {
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status?: unknown }).status) || 0
      : 0;
  return status === 403
    ? "The server refused: your account is not permitted to change the retention window."
    : "The retention change did not reach the server, so nothing changed. Check your connection and try again.";
}

function PortalSessionsSection({
  sessions,
  loading,
  failed,
  scopes,
  mode,
  online,
}: {
  sessions: AuditPortalSession[] | undefined;
  loading: boolean;
  failed: boolean;
  scopes: AuditScopeSet | null | undefined;
  mode: AuditAuthMode;
  online: boolean;
}) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const revoke = useRevokeAuditPortalSession();
  const access = portalRevokeAccess({ scopes, mode, online });
  const now = Date.now();

  const onRevoke = async (session: AuditPortalSession) => {
    const ok = await confirm({
      title: "Revoke this auditor session?",
      message:
        "The external auditor's portal link stops working immediately. Sessions cannot be un-revoked — mint a new one from desktop if access is still needed.",
      confirmLabel: "Revoke",
      destructive: true,
      consequence: "The auditor loses read access the moment this lands.",
    });
    if (!ok) return;
    try {
      await revoke.mutateAsync(session.id);
      toast({ kind: "success", message: "Auditor session revoked." });
    } catch {
      toast({
        kind: "error",
        message:
          "The revoke did not reach the server, so the session is still live. Check your connection and try again.",
      });
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <SectionTitle text="Auditor portal sessions" />
      <Muted text="Time-boxed read sessions for external auditors. Minting a new session stays on desktop — its link is a bearer credential — but a session that should not exist can be revoked from here." />
      {loading ? <Muted text="Loading sessions…" /> : null}
      {failed ? <Muted text="Couldn't load auditor sessions." /> : null}
      {sessions && sessions.length === 0 ? (
        <Muted text="No auditor sessions have been minted." />
      ) : null}
      {(sessions ?? []).map((session) => {
        const state = portalSessionState(session, now);
        return (
          <View
            key={session.id}
            accessible
            accessibilityLabel={`Auditor session, ${state}, scope ${session.scope || "read"}`}
            style={{ gap: 6 }}
          >
            <Muted
              text={`${stateLabel(state)} · scope ${session.scope || "read"} · expires ${
                session.expiresAt ? dateTime(session.expiresAt) : "unknown"
              }${
                session.accessedAt
                  ? ` · last opened ${relativeTime(session.accessedAt)}`
                  : " · never opened"
              }`}
            />
            {access.allowed && isPortalSessionRevocable(session, now) ? (
              <View style={{ flexDirection: "row" }}>
                <AuditAction
                  label={revoke.isPending ? "Revoking…" : "Revoke"}
                  hint="Ends this auditor session immediately"
                  disabled={revoke.isPending}
                  onPress={() => void onRevoke(session)}
                />
              </View>
            ) : null}
          </View>
        );
      })}
      {sessions && sessions.length > 0 && !access.allowed && access.known && access.notice ? (
        <Muted text={access.notice} />
      ) : null}
    </View>
  );
}

function stateLabel(state: "active" | "expired" | "revoked"): string {
  if (state === "active") return "Active";
  return state === "expired" ? "Expired" : "Revoked";
}

function AccessRequestsSection({
  requests,
  failed,
}: {
  requests: AuditAccessRequest[] | undefined;
  failed: boolean;
}) {
  return (
    <View style={{ gap: 8 }}>
      <SectionTitle text="Pending access requests" />
      {failed ? <Muted text="Couldn't load access requests." /> : null}
      {requests && requests.length === 0 ? (
        <Muted text="Nobody is waiting on audit access." />
      ) : null}
      {(requests ?? []).map((request) => (
        <Muted
          key={request.id}
          text={`${accessRequesterLabel(request)}${
            request.note ? ` — “${request.note}”` : ""
          }${
            request.createdAt
              ? ` · asked ${relativeTime(request.createdAt)}`
              : ""
          }`}
        />
      ))}
      {requests && requests.length > 0 ? (
        <Muted
          text={`Granting audit scopes happens on the web admin's roles screen — this list is the ${plural(
            requests.length,
            "request",
          )} waiting for you there.`}
        />
      ) : null}
    </View>
  );
}

function SectionTitle({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("callout")}
      accessibilityRole="header"
      style={{
        color: t.fg,
        fontWeight: "700",
        fontFamily: FONT.bold,
        ...typeStyle("callout"),
      }}
    >
      {text}
    </Text>
  );
}

function Muted({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        fontFamily: FONT.regular,
        ...typeStyle("bodySmall"),
      }}
    >
      {text}
    </Text>
  );
}
