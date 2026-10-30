/**
 * QueuedWriteSheet — one queued write, read as the request it is, and edited
 * in place before it retries.
 *
 * The mobile port of desktop's QueuedMutationEditor (parity register,
 * shell-crosscutting "offline outbox depth"): the verb and path are shown
 * verbatim, a flat body edits as per-field inputs with each field's ORIGINAL
 * type preserved on save, anything else edits as validated raw JSON, and a
 * body that would only be quarantined at replay time is refused here with
 * the reason (lib/queuedBodyEditor). Retry and discard live here too so a
 * failed write has all three verbs in one place.
 *
 * The identity that queued the write is the one reading it (the detail list
 * is scope-matched), so there is no role gate beyond that. A sequence-step
 * save is shown but never edited — the builder owns the step list.
 *
 * NativeWind v4 gotcha: STATIC Pressable styles only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { Pill, type PillTone } from "@/components/Pill";
import {
  SettingsSwitchRow,
  SettingsTextInput,
  settingsInputStyle,
} from "@/components/settings/FormControls";
import {
  SheetButton,
  SheetGroup,
  SheetHeader,
  SheetNote,
} from "@/components/settings/platform-config/PlatformConfigPrimitives";
import { useToast } from "@/components/Toast";
import { useIsOnline } from "@/hooks/useIsOnline";
import type { QueuedWriteReissue } from "@/hooks/useQueuedWriteDetails";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { statusTone } from "@/lib/offlineQueueView";
import {
  buildBodyFromFields,
  deriveFlatFields,
  parseRawBody,
  stringifyBody,
  validateEditedBody,
  type FlatField,
} from "@/lib/queuedBodyEditor";
import type { QueuedWriteDetail } from "@/lib/queuedWriteDetail";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export const DISCARD_EDITS_CONFIRM = {
  title: "Discard your edits?",
  message: "The queued change keeps the body it had before you opened it.",
  confirmLabel: "Discard edits",
  destructive: true,
} as const;

export const SEQUENCE_SAVE_NOTE =
  "Sequence steps are edited in the sequence builder, not here. Open the sequence to re-apply this change.";

export function savedCopy(online: boolean): string {
  return online
    ? "Change saved on this phone · retrying now."
    : "Change saved on this phone · sends when you're back online.";
}

export function QueuedWriteSheet({
  visible,
  detail,
  startEditing = false,
  onClose,
  onReissue,
  onRetry,
  onDiscard,
}: {
  visible: boolean;
  detail: QueuedWriteDetail | null;
  /** Open straight into the editor (the row's Edit verb). */
  startEditing?: boolean;
  onClose: () => void;
  onReissue: (detail: QueuedWriteDetail, body: unknown) => QueuedWriteReissue;
  onRetry: (detail: QueuedWriteDetail) => QueuedWriteReissue;
  onDiscard: (detail: QueuedWriteDetail) => void;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const online = useIsOnline();

  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<FlatField[] | null>(null);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);

  const seed = useCallback(() => {
    if (!detail) return;
    setFields(deriveFlatFields(detail.body));
    setRaw(stringifyBody(detail.body));
    setError(null);
  }, [detail]);

  useEffect(() => {
    if (!visible) return;
    seed();
    setEditing(Boolean(startEditing && detail?.editable));
  }, [visible, seed, startEditing, detail?.editable]);

  const dirty = useMemo(() => {
    if (!detail || !editing) return false;
    if (fields) {
      const original = deriveFlatFields(detail.body);
      return JSON.stringify(original) !== JSON.stringify(fields);
    }
    return raw !== stringifyBody(detail.body);
  }, [detail, editing, fields, raw]);

  const close = useCallback(async () => {
    if (dirty) {
      const ok = await confirm(DISCARD_EDITS_CONFIRM);
      if (!ok) return;
    }
    setEditing(false);
    onClose();
  }, [confirm, dirty, onClose]);

  const save = useCallback(() => {
    if (!detail) return;
    const built = fields ? buildBodyFromFields(fields) : parseRawBody(raw);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const refused = validateEditedBody(detail, built.body);
    if (refused) {
      setError(refused);
      return;
    }
    const result = onReissue(detail, built.body);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    haptics.success();
    toast({ kind: "success", message: savedCopy(online) });
    setEditing(false);
    onClose();
  }, [detail, fields, raw, onReissue, toast, online, onClose]);

  const retry = useCallback(() => {
    if (!detail) return;
    const result = onRetry(detail);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    haptics.tap();
    toast({
      kind: "info",
      message: online ? "Retrying now…" : "Queued — sends when you're back online.",
    });
    onClose();
  }, [detail, onRetry, toast, online, onClose]);

  if (!detail) return null;
  const tone: PillTone = statusTone(detail.status);
  const bodyLines = fields
    ? fields.map((field) => `${field.key}: ${String(field.raw)}`)
    : [stringifyBody(detail.body) || "(no body)"];

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={() => void close()}
      accessibilityLabel={`Queued change: ${detail.label}`}
    >
      <SheetHeader
        title={detail.label}
        subtitle={`${detail.method} ${detail.path}`}
        onClose={() => void close()}
        closeLabel="Close queued change"
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pill
          label={detail.status}
          tone={tone}
          size="sm"
          accessibilityLabel={`Status: ${detail.status}`}
        />
        <Text
          selectable
          {...typeCap("mono")}
          style={{ color: t.fgMuted, ...typeStyle("mono"), fontFamily: FONT.regular }}
        >
          {detail.operationId}
        </Text>
      </View>
      {detail.failure ? (
        <SheetNote tone="danger">
          {[
            detail.failure.status ? `HTTP ${detail.failure.status}` : "No HTTP status",
            detail.failure.code ?? "",
            detail.failure.message,
          ]
            .filter((part) => part.trim().length > 0)
            .join(" · ")}
        </SheetNote>
      ) : null}

      <SheetGroup title={editing ? "Edit the body" : "Body"}>
        {editing && fields
          ? fields.map((field, index) =>
              field.type === "boolean" ? (
                <SettingsSwitchRow
                  key={field.key}
                  label={field.key}
                  value={field.raw === true}
                  onValueChange={(value) =>
                    setFields((prev) =>
                      prev
                        ? prev.map((f, i) => (i === index ? { ...f, raw: value } : f))
                        : prev,
                    )
                  }
                />
              ) : (
                <SettingsTextInput
                  key={field.key}
                  label={field.key}
                  {...(field.type === "number" ? { hint: "A number" } : {})}
                  value={typeof field.raw === "string" ? field.raw : ""}
                  keyboardType={field.type === "number" ? "decimal-pad" : "default"}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={(text) =>
                    setFields((prev) =>
                      prev
                        ? prev.map((f, i) => (i === index ? { ...f, raw: text } : f))
                        : prev,
                    )
                  }
                />
              ),
            )
          : null}
        {editing && !fields ? (
          <TextInput
            accessibilityLabel="Body as JSON"
            value={raw}
            onChangeText={setRaw}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            {...typeCap("mono")}
            style={[settingsInputStyle(t), { minHeight: 120, textAlignVertical: "top" }]}
          />
        ) : null}
        {!editing
          ? bodyLines.map((line, index) => (
              <Text
                key={`${index}:${line}`}
                selectable
                {...typeCap("mono")}
                style={{ color: t.fg, ...typeStyle("mono"), fontFamily: FONT.regular }}
              >
                {line}
              </Text>
            ))
          : null}
      </SheetGroup>

      {error ? <SheetNote tone="danger">{error}</SheetNote> : null}
      {!detail.editable ? <SheetNote tone="warning">{SEQUENCE_SAVE_NOTE}</SheetNote> : null}
      {detail.status === "syncing" ? (
        <SheetNote>This change is on the wire right now; wait for it to settle.</SheetNote>
      ) : null}

      <View style={{ flexDirection: "row", gap: 8, marginTop: 16 }}>
        {editing ? (
          <>
            <SheetButton label="Save and retry" tone="primary" onPress={save} />
            <SheetButton
              label="Cancel"
              tone="neutral"
              onPress={() => {
                seed();
                setEditing(false);
              }}
            />
          </>
        ) : (
          <>
            {detail.editable && detail.status !== "syncing" ? (
              <SheetButton label="Edit" tone="primary" onPress={() => setEditing(true)} />
            ) : null}
            {detail.status !== "syncing" ? (
              <SheetButton label="Retry now" tone="neutral" onPress={retry} />
            ) : null}
            {detail.status !== "syncing" ? (
              <SheetButton
                label="Discard"
                tone="danger"
                onPress={() => {
                  onDiscard(detail);
                  onClose();
                }}
              />
            ) : null}
          </>
        )}
      </View>
    </KeyboardFormSheet>
  );
}
