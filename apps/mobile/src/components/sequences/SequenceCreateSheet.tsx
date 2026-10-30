/**
 * SequenceCreateSheet — name a new sequence and start it as an empty draft.
 *
 * This closes the half of the loop that was built and then never attached: the
 * `OFFLINE_MUTATION_KEYS.sequenceCreate` mutation default, its queue label and
 * its five tests all existed with ZERO UI call sites, so the create path had
 * never once run against a real server. Wiring it surfaced a latent bug that
 * would have made every one of those replays fail — see `api/sequences`.
 *
 * THE ONE THING THIS SHEET MUST NOT IMPLY. Mobile authoring is now ON
 * (`MOBILE_SEQUENCE_AUTHORING_AVAILABLE`), but the step PALETTE was not
 * restored with it — so the draft this creates opens onto an empty canvas that
 * can edit and reorder steps and cannot create one. `SEQUENCE_CREATE_SCOPE_NOTE`
 * is therefore still not decoration: it is the sentence that stops "New
 * sequence" from reading as a promise the next screen breaks. It is announced
 * as part of the field's accessibility hint too, so it is not a sighted-only
 * disclosure.
 *
 * OFFLINE. The mutation is `offlineSafeMutationMeta` + the shared key, so with
 * the gate closed TanStack pauses it, the persister writes it to the encrypted
 * vault and it replays on reconnect. That is a genuinely different outcome
 * from "created", and `sequenceCreatedMessage` says which one happened rather
 * than reporting success for a row that does not exist yet.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text, TextInput, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { useToast } from "@/components/Toast";
import { useIsOnline } from "@/hooks/useIsOnline";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  executeSequenceCreate,
  newOfflineMutationMetadata,
  OFFLINE_MUTATION_KEYS,
  recordSequenceCreateFailure,
} from "@/lib/offlineMutations";
import { offlineSafeMutationMeta } from "@/lib/queryClient";
import {
  SEQUENCE_CREATE_SCOPE_NOTE,
  SEQUENCE_NAME_MAX_RUNES,
  nameRemaining,
  sequenceCreateErrorMessage,
  sequenceCreatedMessage,
  validateSequenceName,
} from "@/lib/sequenceCreate";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SequenceCreateSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Called with the new sequence's id once the server has confirmed one.
   *  NEVER called for a queued create — there is no id to open. */
  onCreated: (id: string) => void;
}

export function SequenceCreateSheet({
  visible,
  onClose,
  onCreated,
}: SequenceCreateSheetProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const qc = useQueryClient();
  const online = useIsOnline();
  const [name, setName] = useState("");
  const [submitted, setSubmitted] = useState(false);
  /**
   * True while the in-flight create was submitted OFFLINE.
   *
   * This sheet stays mounted after it closes (it renders a `Modal` whose
   * `visible` is false), so its mutation observer survives — and a PAUSED
   * mutation eventually resolves through THIS `onSuccess` when the network
   * returns. Without this flag, queueing a draft on a plane produced two
   * toasts ("will be created when you're back online", then "created as an
   * empty draft" minutes later) and, worse, yanked the operator out of
   * whatever they were doing and into the new sequence. A queued create has
   * already been reported; its replay is the queue's business, not the
   * sheet's.
   */
  const queuedRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    setName("");
    setSubmitted(false);
  }, [visible]);

  const check = useMemo(() => validateSequenceName(name), [name]);
  // Only complain once the operator has tried — an error under an untouched
  // field is noise, not help.
  const error = submitted && !check.ok ? check.error : null;
  const remaining = nameRemaining(name);

  const create = useMutation({
    mutationKey: OFFLINE_MUTATION_KEYS.sequenceCreate,
    meta: offlineSafeMutationMeta,
    mutationFn: executeSequenceCreate,
    onSuccess: (result, vars) => {
      void qc.invalidateQueries({ queryKey: ["sequences"] });
      if (queuedRef.current) {
        // Replay of something already reported as queued. The list refresh
        // above is the whole visible outcome; the offline-queue banner owns
        // telling the operator their queued write landed.
        queuedRef.current = false;
        return;
      }
      haptics.success();
      toast({
        kind: "success",
        message: sequenceCreatedMessage({ name: vars.name, queued: false }),
      });
      onClose();
      const id = result?.data?.id;
      if (typeof id === "string" && id.trim()) onCreated(id);
    },
    onError: (err: unknown, vars) => {
      recordSequenceCreateFailure(vars, err);
      if (queuedRef.current) {
        // A queued create that failed on replay is recorded above and
        // surfaced by the offline-failure banner, which is the surface that
        // can still be seen minutes later. A toast fired at whatever screen
        // happens to be open is not.
        queuedRef.current = false;
        return;
      }
      haptics.error();
      const status =
        typeof (err as { status?: unknown })?.status === "number"
          ? (err as { status: number }).status
          : 0;
      toast({
        kind: "error",
        message: sequenceCreateErrorMessage(
          status,
          err instanceof Error ? err.message : undefined,
        ),
      });
    },
  });

  const submit = () => {
    setSubmitted(true);
    if (create.isPending) {
      // A PAUSED offline create is also `isPending`, and it stays that way
      // until the network returns — so this guard is reachable minutes after
      // the sheet was last used. Returning silently made the button look
      // broken; say which of the two states we are in.
      toast({
        kind: "info",
        message: online
          ? "Still creating the last one — give it a moment."
          : "A sequence is already queued. It will be created when you're back online.",
      });
      return;
    }
    if (!check.ok) {
      haptics.error();
      return;
    }
    // `currentOfflineAuthScope` THROWS when the identity is incomplete — a
    // queued write must never be stamped with a half-identity, because that is
    // what would let it replay into the wrong workspace on a shared device.
    // Catch it here so the sheet reports it instead of the render crashing.
    let metadata: ReturnType<typeof newOfflineMutationMetadata>;
    try {
      metadata = newOfflineMutationMetadata();
    } catch (err) {
      haptics.error();
      toast({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Sign in again before creating a sequence.",
      });
      return;
    }
    haptics.tap();
    queuedRef.current = !online;
    create.mutate({ ...metadata, name: check.name });
    // A paused (offline) mutation never resolves onSuccess, so the sheet has
    // to report the queued outcome itself and close: leaving a spinner up
    // until reconnect is the failure mode this whole substrate exists to fix.
    if (!online) {
      toast({
        kind: "info",
        message: sequenceCreatedMessage({ name: check.name, queued: true }),
      });
      onClose();
    }
  };

  const busy = create.isPending && online;

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="New sequence"
      contentContainerStyle={{ gap: 14 }}
    >
      <Text
        {...typeCap("title")}
        accessibilityRole="header"
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        New sequence
      </Text>

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {SEQUENCE_CREATE_SCOPE_NOTE}
      </Text>

      <View style={{ gap: 6 }}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Winback series"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Sequence name"
          accessibilityHint={SEQUENCE_CREATE_SCOPE_NOTE}
          autoCapitalize="sentences"
          autoCorrect
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submit}
          editable={!busy}
          // The server counts RUNES; `maxLength` counts UTF-16 units, so it
          // is set generously and `validateSequenceName` is the real gate.
          // A tight maxLength here would silently truncate emoji names that
          // the server would have accepted.
          maxLength={SEQUENCE_NAME_MAX_RUNES * 2}
          maxFontSizeMultiplier={typeCap("body").maxFontSizeMultiplier}
          style={{
            minHeight: 48,
            color: t.fg,
            backgroundColor: t.surface,
            borderColor: error ? t.danger : t.border,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingVertical: 12,
            fontFamily: FONT.regular,
            fontSize: typeStyle("body").fontSize,
          }}
        />
        {error ? (
          <Text
            {...typeCap("bodySmall")}
            accessibilityRole="alert"
            style={{
              color: t.danger,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {error}
          </Text>
        ) : remaining !== null ? (
          <Text
            {...typeCap("caption")}
            // The visible glyph is a bare number; the spoken value names the
            // unit, because "12" alone tells a VoiceOver user nothing.
            accessibilityLabel={`${remaining} characters remaining of ${SEQUENCE_NAME_MAX_RUNES}`}
            style={{
              color: remaining < 0 ? t.danger : t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            {remaining} left
          </Text>
        ) : null}
      </View>

      {!online ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          You&apos;re offline. This sequence will be queued and created the next time
          the app reaches the server.
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 10 }}>
        <SheetButton
          label="Cancel"
          onPress={onClose}
          disabled={busy}
          primary={false}
        />
        <SheetButton
          label={busy ? "Creating…" : online ? "Create draft" : "Queue draft"}
          onPress={submit}
          disabled={busy}
          primary
        />
      </View>
    </KeyboardFormSheet>
  );
}

function SheetButton({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  primary: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        flex: 1,
        minHeight: 48,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: primary ? t.accent : t.border,
        backgroundColor: primary ? t.accent : t.surface,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: primary ? t.accentFg : t.fg,
          ...typeStyle("body"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
