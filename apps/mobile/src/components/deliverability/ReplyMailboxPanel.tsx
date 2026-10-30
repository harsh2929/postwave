/**
 * ReplyMailboxPanel — the registry reply capture is polled from.
 *
 * It sits on Deliverability beside the other in-flight resources
 * (verification jobs, Inbox Reality tests) because a broken reply mailbox is
 * the same class of fact: something ingesting on your behalf has stopped.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { useConfirm } from "@/components/ConfirmSheet";
import { ReplyMailboxRow } from "@/components/deliverability/ReplyMailboxRow";
import { useToast } from "@/components/Toast";
import {
  useCanManageReplyMailboxes,
  useDeleteReplyMailbox,
  useReplyMailboxes,
  useSetReplyMailboxEnabled,
} from "@/hooks/useReplyMailboxes";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  MAILBOX_CREATE_NOTICE,
  mailboxDeleteConsequence,
  type ReplyMailbox,
} from "@/lib/replyMailboxes";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ReplyMailboxPanel() {
  const { t } = useTheme();
  const confirm = useConfirm();
  const { toast } = useToast();
  const query = useReplyMailboxes();
  const setEnabled = useSetReplyMailboxEnabled();
  const remove = useDeleteReplyMailbox();
  const mayManage = useCanManageReplyMailboxes();
  const gate = useOnlineQueryGate();
  const online = gate.enabled;

  const hasRowsPayload = Array.isArray(query.data);
  const malformedPayload = query.data !== undefined && !hasRowsPayload;
  const rows = Array.isArray(query.data) ? query.data : [];
  const initialFailure = (query.isError || malformedPayload) && !hasRowsPayload;
  const refreshFailure = query.isError && hasRowsPayload;
  const initialLoading =
    !hasRowsPayload && !initialFailure && online && (query.isLoading || query.isPending);

  const onToggle = useCallback(
    async (mailbox: ReplyMailbox) => {
      haptics.tap();
      const next = !mailbox.enabled;
      if (next && mailbox.securityQuarantinedAt) {
        toast({
          kind: "error",
          message: "This legacy registration is security-quarantined. Delete it and use web or desktop to register a safe replacement.",
        });
        return;
      }
      const ok = await confirm({
        title: `${next ? "Enable" : "Disable"} ${mailbox.label}?`,
        message: next
          ? "Polling will resume from the stored cursor."
          : "Polling will stop without deleting the registration.",
        consequence: next
          ? "This confirms registry state only; it does not certify a successful live mailbox connection."
          : "The poll cursor is retained so polling can resume later.",
        confirmLabel: next ? "Enable polling" : "Disable polling",
        destructive: !next,
      });
      if (!ok) return;
      try {
        await setEnabled.mutateAsync({ id: mailbox.id, enabled: next });
        toast({
          kind: "success",
          message: next
            ? `${mailbox.label} is enabled. Live mailbox connectivity is not yet certified.`
            : `${mailbox.label} stopped polling. Its cursor is kept.`,
        });
      } catch (err) {
        toast({
          kind: "error",
          message:
            errorPresentation(err).message ||
            `Couldn't ${next ? "enable" : "disable"} ${mailbox.label}.`,
        });
      }
    },
    [confirm, setEnabled, toast],
  );

  const onDelete = useCallback(
    async (mailbox: ReplyMailbox) => {
      haptics.tap();
      const ok = await confirm({
        title: `Remove ${mailbox.label}?`,
        message: "Polling stops and the registration is deleted.",
        consequence: mailboxDeleteConsequence(mailbox),
        confirmLabel: "Remove",
        destructive: true,
        confirmPhrase: mailbox.label,
      });
      if (!ok) return;
      try {
        await remove.mutateAsync(mailbox.id);
        toast({ kind: "success", message: `${mailbox.label} removed.` });
      } catch (err) {
        toast({
          kind: "error",
          message:
            errorPresentation(err).message || `Couldn't remove ${mailbox.label}.`,
        });
      }
    },
    [confirm, remove, toast],
  );

  const busy = setEnabled.isPending || remove.isPending;

  return (
    <View style={{ marginTop: 16 }}>
      <Card>
        <Text
          {...typeCap("body")}
          style={{ color: t.fg, ...typeStyle("body"), fontFamily: FONT.semibold }}
        >
          Reply mailboxes
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginTop: 4,
          }}
        >
          Registry and poller evidence only—not live mailbox certification.
        </Text>

        {!online ? (
          <Text
            accessibilityRole="alert"
            {...typeCap("label")}
            style={{
              color: t.warning,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 10,
            }}
          >
            Reconnect to verify mailbox state or make changes. Last-loaded rows may be stale.
          </Text>
        ) : null}

        {initialLoading ? (
          <Text
            accessibilityRole="text"
            accessibilityLiveRegion="polite"
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 10,
            }}
          >
            Loading reply mailboxes…
          </Text>
        ) : initialFailure ? (
          <View style={{ gap: 8, marginTop: 10 }}>
            <Text
              accessibilityRole="alert"
              {...typeCap("label")}
              style={{
                color: t.warning,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              Reply mailboxes could not be verified. This is not being shown as an empty registry.
            </Text>
            <Pressable
              onPress={() => void query.refetch()}
              disabled={!online || query.isFetching}
              accessibilityRole="button"
              accessibilityLabel="Retry loading reply mailboxes"
              accessibilityState={{ disabled: !online || query.isFetching }}
              style={{ minHeight: 44, justifyContent: "center", alignSelf: "flex-start" }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: !online || query.isFetching ? t.fgSubtle : t.accent,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                Retry
              </Text>
            </Pressable>
          </View>
        ) : hasRowsPayload && rows.length === 0 ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 10,
            }}
          >
            No reply mailboxes are registered in this workspace.
          </Text>
        ) : !hasRowsPayload && !online ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 10,
            }}
          >
            Mailbox state has not been loaded on this connection.
          </Text>
        ) : null}

        {rows.map((mailbox) => (
          <ReplyMailboxRow
            key={mailbox.id}
            mailbox={mailbox}
            online={online}
            busy={busy}
            mayManage={mayManage}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        ))}

        {refreshFailure ? (
          <Text
            accessibilityRole="alert"
            {...typeCap("label")}
            style={{
              color: t.warning,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 10,
            }}
          >
            The latest refresh failed. Last verified rows remain visible.
          </Text>
        ) : null}

        {mayManage && hasRowsPayload ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 10,
            }}
          >
            {MAILBOX_CREATE_NOTICE}
          </Text>
        ) : null}
      </Card>
    </View>
  );
}
