/**
 * SmsQuickReplyPicker — the canned-response library on the thread composer.
 *
 * Three surfaces behind one entry point, all built on existing primitives:
 *   pick    RowActionSheet listing replies ranked most-used-first (server
 *           order), each hint previewing the body; picking INSERTS into the
 *           composer draft — it never sends (and the send itself is
 *           release-held server-side, which the subtitle says out loud);
 *   create  KeyboardFormSheet with label + body, validated by the same rules
 *           the server enforces;
 *   delete  a destructive RowActionSheet behind ConfirmSheet — deleting a
 *           saved reply is irreversible.
 */
import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { RowActionSheet, type RowAction } from "@/components/RowActionSheet";
import { useToast } from "@/components/Toast";
import type { SmsInboxAccess } from "@/hooks/useSmsInbox";
import {
  useSmsQuickReplies,
  useSmsQuickReplyWrites,
} from "@/hooks/useSmsQuickReplies";
import { writeFailureMessage } from "@/lib/deliverabilitySignals";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import { safeSmsDisplayText } from "@/lib/smsConversation";
import {
  smsQuickReplyBodyError,
  smsQuickReplyLabelError,
  type SmsQuickReply,
} from "@/lib/smsQuickReply";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export function SmsQuickReplyPicker({
  visible,
  access,
  onInsert,
  onClose,
}: {
  visible: boolean;
  access: SmsInboxAccess;
  /** Insert the picked body into the composer draft. */
  onInsert: (reply: SmsQuickReply) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [mode, setMode] = useState<"pick" | "create" | "delete">("pick");
  const replies = useSmsQuickReplies(access, visible);
  const writes = useSmsQuickReplyWrites(access);
  // `?? []` would let a truthy non-array (a paged envelope, an HTML SPA
  // fallback) reach .slice/.map below and throw. Check the type.
  const rows = Array.isArray(replies.data?.replies)
    ? replies.data.replies
    : [];

  const close = () => {
    setMode("pick");
    onClose();
  };

  const pickActions: RowAction[] = [
    ...rows.slice(0, 50).map((reply) => ({
      key: reply.id,
      label: reply.label,
      hint: previewLine(reply),
      onPress: () => {
        haptics.tap();
        onInsert(reply);
        close();
      },
    })),
    {
      key: "__create",
      label: "New quick reply…",
      hint:
        rows.length === 0
          ? "Save a canned response for the whole workspace"
          : undefined,
      disabled: writes.isPending,
      onPress: () => setMode("create"),
    },
    ...(rows.length > 0
      ? [
          {
            key: "__delete",
            label: "Delete a quick reply…",
            destructive: true,
            disabled: writes.isPending,
            onPress: () => setMode("delete"),
          } satisfies RowAction,
        ]
      : []),
  ];

  const deleteActions: RowAction[] = rows.slice(0, 50).map((reply) => ({
    key: reply.id,
    label: reply.label,
    hint: previewLine(reply),
    destructive: true,
    disabled: writes.isPending,
    onPress: () => {
      void (async () => {
        const confirmed = await confirm({
          title: `Delete “${reply.label}”?`,
          message:
            "This removes the quick reply for every operator in the workspace. It cannot be undone.",
          confirmLabel: "Delete",
          destructive: true,
        });
        if (!confirmed) return;
        writes.mutate(
          { action: "delete", id: reply.id },
          {
            onSuccess: () => {
              haptics.success();
              toast({ kind: "info", message: "Quick reply deleted." });
              setMode("pick");
            },
            onError: (error) => {
              haptics.error();
              toast({
                kind: "error",
                message: writeFailureMessage(
                  error,
                  "The quick reply was not deleted.",
                ),
              });
            },
          },
        );
      })();
    },
  }));

  return (
    <>
      <RowActionSheet
        visible={visible && mode === "pick"}
        title="Quick replies"
        subtitle={
          replies.isError
            ? "The library could not be loaded."
            : "Picking inserts the text into the draft — nothing is sent. Live reply dispatch is still release-held."
        }
        actions={pickActions}
        onClose={close}
      />
      <RowActionSheet
        visible={visible && mode === "delete"}
        title="Delete a quick reply"
        subtitle="Deletion is workspace-wide and cannot be undone."
        actions={deleteActions}
        onClose={() => setMode("pick")}
      />
      <CreateSheet
        visible={visible && mode === "create"}
        busy={writes.isPending}
        onClose={() => setMode("pick")}
        onCreate={(label, body) =>
          writes.mutate(
            { action: "create", label, body },
            {
              onSuccess: () => {
                haptics.success();
                toast({ kind: "info", message: "Quick reply saved." });
                setMode("pick");
              },
              onError: (error) => {
                haptics.error();
                toast({
                  kind: "error",
                  message: writeFailureMessage(
                    error,
                    "The quick reply was not saved.",
                  ),
                });
              },
            },
          )
        }
      />
    </>
  );
}

function previewLine(reply: SmsQuickReply): string {
  const body = safeSmsDisplayText(reply.body, 80);
  return reply.useCount > 0 ? `${body} · used ${reply.useCount}×` : body;
}

function CreateSheet({
  visible,
  busy,
  onClose,
  onCreate,
}: {
  visible: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (label: string, body: string) => void;
}) {
  const { t } = useTheme();
  const [label, setLabel] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<TextInput>(null);

  const submit = () => {
    const trimmedLabel = label.trim();
    const invalid =
      smsQuickReplyLabelError(trimmedLabel) ?? smsQuickReplyBodyError(body);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    onCreate(trimmedLabel, body);
    setLabel("");
    setBody("");
  };

  const inputStyle = {
    color: t.fg,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: FONT.regular,
    fontSize: fontSizeFor("bodySmall"),
  } as const;

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="New quick reply"
    >
      <View style={{ gap: 8 }}>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
          }}
        >
          New quick reply
        </Text>
        <TextInput
          {...typeCap("bodySmall")}
          value={label}
          onChangeText={(next) => {
            setLabel(next);
            setError(null);
          }}
          placeholder="Label (e.g. Refund policy)"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Quick reply label"
          autoCapitalize="sentences"
          {...keyboardChain({ next: bodyRef })}
          style={{ ...inputStyle, minHeight: 40 }}
        />
        <TextInput
          {...typeCap("bodySmall")}
          ref={bodyRef}
          value={body}
          onChangeText={(next) => {
            setBody(next);
            setError(null);
          }}
          placeholder="Reply text"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Quick reply text"
          multiline
          style={{ ...inputStyle, minHeight: 72, textAlignVertical: "top" }}
        />
        {error ? (
          <Text
            accessibilityLiveRegion="polite"
            {...typeCap("caption")}
            style={{
              color: t.danger,
              ...typeStyle("caption"),
              fontFamily: FONT.medium,
            }}
          >
            {error}
          </Text>
        ) : null}
        <Pressable
          onPress={submit}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Save quick reply"
          accessibilityState={{ disabled: busy }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: busy ? t.fgMuted : t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {busy ? "Saving…" : "Save quick reply"}
          </Text>
        </Pressable>
      </View>
    </KeyboardFormSheet>
  );
}
