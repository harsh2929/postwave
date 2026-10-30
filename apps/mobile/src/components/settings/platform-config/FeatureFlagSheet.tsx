/**
 * FeatureFlagSheet — create or edit this workspace's override for one flag,
 * or remove it.
 *
 * WHY. PlatformConfigSection listed flags and said "changed on the web
 * admin". The parity register (docs/mobile-desktop-parity-2026-08-28.md,
 * "Feature-flag override authoring") judged a validated form with the key
 * shown verbatim not to be a mis-tap. Desktop anchor: components/settings/
 * FeatureFlagsSection.tsx — its save toast, removal consequence and
 * discard-draft confirm are reused word for word.
 *
 * THE KEY IS FIXED WHEN EDITING. POST upserts on (tenant, key); a row opened
 * for editing keeps its key verbatim, so a typo cannot quietly create a
 * second flag. Only a fresh override takes a typed key.
 *
 * TWO CONFIRMS, BOTH DESTRUCTIVE: removing the override (the platform default
 * is untouched, in desktop's sentence) and discarding a dirty draft on close —
 * including the sheet's own swipe-down, which routes through the same guard
 * via a ref the body keeps current.
 *
 * ROLE. Both writes are admin. Below admin the fields read only and the rule
 * is stated; a viewer never sees a button that would 403.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import {
  SettingsField,
  SettingsTextInput,
} from "@/components/settings/FormControls";
import {
  SheetButton,
  SheetGroup,
  SheetHeader,
  SheetNote,
} from "@/components/settings/platform-config/PlatformConfigPrimitives";
import { useToast } from "@/components/Toast";
import {
  useDeleteFeatureFlagOverride,
  useUpsertFeatureFlag,
} from "@/hooks/useFeatureFlagOverrides";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  ADMIN_ONLY_NOTE,
  useCanAdminPlatformConfig,
} from "@/hooks/usePlatformConfigRole";
import { errorPresentation } from "@/lib/errorCopy";
import {
  DEFAULT_ROW_NOTE,
  emptyFlagDraft,
  flagDraftDirty,
  flagDraftFromRow,
  flagUpsertBody,
  overrideRemovalConsequence,
  validateFlagDraft,
  type FlagDraft,
} from "@/lib/featureFlagOverrides";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import type { FeatureFlagView } from "@/lib/platformConfig";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Desktop's discard-draft confirm, verbatim. */
export const DISCARD_DRAFT_CONFIRM = {
  title: "Discard feature-flag draft?",
  message: "The key, value, and note have not been saved.",
  confirmLabel: "Discard draft",
} as const;

export interface FeatureFlagSheetProps {
  visible: boolean;
  /** The row being edited, or null to create a new override. */
  flag: FeatureFlagView | null;
  onClose: () => void;
}

export function FeatureFlagSheet({ visible, flag, onClose }: FeatureFlagSheetProps) {
  const confirm = useConfirm();
  // Kept current by the body; read here so the sheet's own dismissal
  // (swipe-down, hardware back) is guarded exactly like the Close control.
  const dirtyRef = useRef(false);
  const requestClose = useCallback(async () => {
    if (dirtyRef.current) {
      const ok = await confirm({ ...DISCARD_DRAFT_CONFIRM, destructive: true });
      if (!ok) return;
    }
    dirtyRef.current = false;
    onClose();
  }, [confirm, onClose]);
  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={() => void requestClose()}
      accessibilityLabel="Feature flag"
      contentContainerStyle={{ paddingTop: 12 }}
    >
      <SheetHeader
        title={flag ? "Feature flag" : "New override"}
        subtitle={
          flag
            ? "This workspace's value and note for the flag."
            : "An override applies to this workspace only."
        }
        onClose={() => void requestClose()}
        closeLabel="Close feature flag"
      />
      {/* Keyed on the row so every open starts from that row, never from the
          last one's half-typed draft. */}
      {visible ? (
        <FlagBody
          key={flag?.key ?? "new"}
          flag={flag}
          dirtyRef={dirtyRef}
          onClose={onClose}
        />
      ) : null}
    </KeyboardFormSheet>
  );
}

function FlagBody({
  flag,
  dirtyRef,
  onClose,
}: {
  flag: FeatureFlagView | null;
  dirtyRef: MutableRefObject<boolean>;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const canAdmin = useCanAdminPlatformConfig();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const upsert = useUpsertFeatureFlag();
  const remove = useDeleteFeatureFlagOverride();

  const initial = useMemo(
    () => (flag ? flagDraftFromRow(flag) : emptyFlagDraft()),
    [flag],
  );
  const [draft, setDraft] = useState<FlagDraft>(initial);
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const dirty = flagDraftDirty(draft, initial);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty, dirtyRef]);
  // Errors appear after the first attempt, not as a wall of red on open.
  const errors = attempted ? validateFlagDraft(draft) : null;
  const offline = !gate.enabled;
  const busy = upsert.isPending || remove.isPending;
  const locked = !canAdmin || busy;
  const creating = flag === null;
  const isOverride = flag !== null && !flag.isDefault;

  function setField(key: keyof FlagDraft, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function onSave() {
    if (locked || offline) return;
    if (validateFlagDraft(draft)) {
      setAttempted(true);
      haptics.warning();
      return;
    }
    haptics.tap();
    setFormError(null);
    upsert.mutate(flagUpsertBody(draft), {
      onSuccess: (result) => {
        dirtyRef.current = false;
        toast({ kind: "success", message: `Flag "${result.key}" saved` });
        onClose();
      },
      onError: (err) => {
        const message = errorPresentation(err).message || "Couldn't save the flag.";
        setFormError(message);
        toast({ kind: "error", message });
      },
    });
  }

  async function onRemove() {
    if (!flag || !isOverride || locked || offline) return;
    haptics.tap();
    const ok = await confirm({
      title: `Remove override for "${flag.key}"?`,
      consequence: overrideRemovalConsequence(flag.key),
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setFormError(null);
    remove.mutate(flag.key, {
      onSuccess: () => {
        dirtyRef.current = false;
        toast({ kind: "success", message: `Override for "${flag.key}" removed` });
        onClose();
      },
      onError: (err) => {
        const message =
          errorPresentation(err).message || "Couldn't remove the override.";
        setFormError(message);
        toast({ kind: "error", message });
      },
    });
  }

  return (
    <View>
      {!canAdmin ? <SheetNote>{ADMIN_ONLY_NOTE}</SheetNote> : null}
      {offline ? (
        <SheetNote tone="warning">
          You’re offline — the flag can be read but not changed until you reconnect.
        </SheetNote>
      ) : null}
      <SheetGroup title="Flag">
        {creating ? (
          <SettingsTextInput
            label="Key"
            hint="The flag's key, exactly. No spaces."
            value={draft.key}
            onChangeText={(v) => setField("key", v)}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!locked}
          />
        ) : (
          <SettingsField label="Key">
            <Text
              selectable
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
              }}
            >
              {flag.key}
            </Text>
          </SettingsField>
        )}
        {errors?.key ? <SheetNote tone="danger">{errors.key}</SheetNote> : null}
        <SettingsTextInput
          label="Value"
          hint="“on” or “off” for a simple switch."
          value={draft.value}
          onChangeText={(v) => setField("value", v)}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!locked}
        />
        {errors?.value ? <SheetNote tone="danger">{errors.value}</SheetNote> : null}
        <SettingsTextInput
          label="Note"
          hint="Why this workspace differs — optional."
          value={draft.note}
          onChangeText={(v) => setField("note", v)}
          multiline
          editable={!locked}
        />
        {flag?.isDefault ? <SheetNote>{DEFAULT_ROW_NOTE}</SheetNote> : null}
      </SheetGroup>
      {formError ? <SheetNote tone="danger">{formError}</SheetNote> : null}
      {canAdmin ? (
        <View style={{ flexDirection: "row", gap: 10 }}>
          <SheetButton
            label={
              upsert.isPending
                ? "Saving…"
                : creating
                  ? "Create override"
                  : "Save override"
            }
            tone="primary"
            disabled={locked || offline || (!creating && !dirty)}
            onPress={onSave}
          />
        </View>
      ) : null}
      {canAdmin && isOverride ? (
        <View style={{ marginTop: 12, flexDirection: "row" }}>
          <SheetButton
            label={remove.isPending ? "Removing…" : "Remove override"}
            tone="danger"
            disabled={locked || offline}
            onPress={() => void onRemove()}
            accessibilityHint="Asks for confirmation. The platform default is untouched."
          />
        </View>
      ) : null}
    </View>
  );
}
