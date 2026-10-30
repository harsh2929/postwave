/**
 * IdentifierTransformsSheet — edit the workspace's identifier-transform rules
 * from the phone, with a live preview of the UNSAVED draft and a confirm
 * before the save.
 *
 * WHY. PlatformConfigSection could show that "+tag" addresses were being
 * collapsed but could not change it. The parity register (docs/mobile-
 * desktop-parity-2026-08-28.md, "Identifier-transform rules") judged the edit
 * phone-shaped on two conditions, both enforced here: the preview shows what
 * a save would do before it is done, and the save sits behind a confirm that
 * restates every changed rule under the scope sentence. Desktop anchor:
 * components/settings/IdentifierTransformsSection.tsx.
 *
 * ONLY CHANGED FIELDS TRAVEL (identifierTransformsPatch): the server's pointer
 * semantics mean an untouched rule is never re-asserted from a phone over a
 * value set at a desk.
 *
 * THE PREVIEW BODY IS MEMOISED ON ITS PRIMITIVES. The preview hook debounces
 * on the body's identity; a fresh object every render would restart the
 * timer on every render and the preview would never settle.
 *
 * ROLE. PATCH is admin — and so is the GET, so a non-admin rarely reaches
 * this sheet at all. The branch below is the stale-role case and reads as the
 * rule, not as a 403.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import {
  SettingsSwitchRow,
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
  useIdentifierTransformPreview,
  useUpdateIdentifierTransforms,
} from "@/hooks/useIdentifierTransformsEdit";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  ADMIN_ONLY_NOTE,
  useCanAdminPlatformConfig,
} from "@/hooks/usePlatformConfigRole";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  DEFAULT_PREVIEW_EMAIL,
  DEFAULT_PREVIEW_PHONE,
  IDENTIFIER_TRANSFORM_PHONE_REGIONS,
  identifierTransformsPatch,
  previewLineText,
  previewRequestBody,
  TRANSFORM_SCOPE_SENTENCE,
  transformChangeLines,
  validateIdentifierTransformsDraft,
  type IdentifierTransformsDraft,
  type TransformPreviewRequest,
} from "@/lib/identifierTransformsEdit";
import type { IdentifierTransformsView } from "@/lib/platformConfig";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface IdentifierTransformsSheetProps {
  visible: boolean;
  /** The saved rules the sheet opens on; null while the card has none. */
  server: IdentifierTransformsView | null;
  onClose: () => void;
}

export function IdentifierTransformsSheet({
  visible,
  server,
  onClose,
}: IdentifierTransformsSheetProps) {
  const open = visible && server !== null;
  return (
    <KeyboardFormSheet
      visible={open}
      onClose={onClose}
      accessibilityLabel="Identifier transforms"
      contentContainerStyle={{ paddingTop: 12 }}
    >
      <SheetHeader
        title="Identifier transforms"
        subtitle="How incoming email addresses and phone numbers are rewritten before they are matched."
        onClose={onClose}
        closeLabel="Close identifier transforms"
      />
      {/* Mounted only while open, so every open starts from the saved rules
          with no half-toggled draft from the last one. */}
      {open && server ? (
        <TransformsBody server={server} onClose={onClose} />
      ) : null}
    </KeyboardFormSheet>
  );
}

function TransformsBody({
  server,
  onClose,
}: {
  server: IdentifierTransformsView;
  onClose: () => void;
}) {
  const canAdmin = useCanAdminPlatformConfig();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const save = useUpdateIdentifierTransforms();

  const [draft, setDraft] = useState<IdentifierTransformsDraft>(server);
  const [sampleEmail, setSampleEmail] = useState(DEFAULT_PREVIEW_EMAIL);
  const [samplePhone, setSamplePhone] = useState(DEFAULT_PREVIEW_PHONE);
  const [saveError, setSaveError] = useState<string | null>(null);

  const patch = identifierTransformsPatch(server, draft);
  const validation = validateIdentifierTransformsDraft(draft);
  const offline = !gate.enabled;
  const locked = !canAdmin || save.isPending;

  const previewBody = useMemo<TransformPreviewRequest | null>(() => {
    if (validation || offline) return null;
    if (!sampleEmail.trim() && !samplePhone.trim()) return null;
    return previewRequestBody(draft, sampleEmail, samplePhone);
  }, [draft, sampleEmail, samplePhone, validation, offline]);
  const preview = useIdentifierTransformPreview(previewBody);

  function setField<K extends keyof IdentifierTransformsDraft>(
    key: K,
    value: IdentifierTransformsDraft[K],
  ) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onSave() {
    if (!patch || locked || validation) return;
    haptics.tap();
    const ok = await confirm({
      title: "Save identifier rules?",
      message: TRANSFORM_SCOPE_SENTENCE,
      consequence: transformChangeLines(patch).join("\n"),
      confirmLabel: "Save",
    });
    if (!ok) return;
    setSaveError(null);
    save.mutate(patch, {
      onSuccess: () => {
        toast({ kind: "success", message: "Identifier transforms saved." });
        onClose();
      },
      onError: (err) => {
        const message =
          errorPresentation(err).message || "Couldn't save the identifier rules.";
        setSaveError(message);
        toast({ kind: "error", message });
      },
    });
  }

  return (
    <View>
      {!canAdmin ? <SheetNote>{ADMIN_ONLY_NOTE}</SheetNote> : null}
      {offline ? (
        <SheetNote tone="warning">
          You’re offline — the preview and the save both need a connection.
        </SheetNote>
      ) : null}
      <SheetGroup title="Email">
        <SettingsSwitchRow
          label="Remove dots from the local-part"
          hint="j.o.h.n@gmail.com is stored as john@gmail.com."
          value={draft.emailNormalizeDots}
          disabled={locked}
          onValueChange={(v) => setField("emailNormalizeDots", v)}
        />
        <SettingsSwitchRow
          label="Drop “+tag” sub-addresses"
          hint="john+promo@gmail.com is stored as john@gmail.com."
          value={draft.emailNormalizePlus}
          disabled={locked}
          onValueChange={(v) => setField("emailNormalizePlus", v)}
        />
      </SheetGroup>
      <SheetGroup title="Phone">
        <SettingsSwitchRow
          label="Coerce numbers to E.164"
          hint="National-format numbers need a default region to gain a country code."
          value={draft.phoneE164Format}
          disabled={locked}
          onValueChange={(v) => setField("phoneE164Format", v)}
        />
        {draft.phoneE164Format ? (
          <RegionPicker
            value={draft.phoneDefaultRegion}
            disabled={locked}
            onChange={(v) => setField("phoneDefaultRegion", v)}
          />
        ) : null}
        {validation ? <SheetNote tone="danger">{validation}</SheetNote> : null}
      </SheetGroup>
      <SheetGroup title="Preview">
        <SettingsTextInput
          label="Sample email"
          value={sampleEmail}
          onChangeText={setSampleEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
        <SettingsTextInput
          label="Sample phone"
          value={samplePhone}
          onChangeText={setSamplePhone}
          keyboardType="phone-pad"
        />
        <PreviewLines body={previewBody} query={preview} />
      </SheetGroup>
      {saveError ? <SheetNote tone="danger">{saveError}</SheetNote> : null}
      {canAdmin ? (
        <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
          <SheetButton
            label={save.isPending ? "Saving…" : "Save rules"}
            tone="primary"
            disabled={
              !patch || Boolean(validation) || offline || save.isPending
            }
            onPress={() => void onSave()}
            accessibilityHint="Asks for confirmation before saving."
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The default-region picker: one row stating the current choice, which
 * expands into the region list. A code the list does not carry (set at a
 * desk) is still shown verbatim rather than as "None".
 */
function RegionPicker({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const current = IDENTIFIER_TRANSFORM_PHONE_REGIONS.find(
    (region) => region.value === value,
  );
  const currentLabel = current ? current.label : value || "None";
  return (
    <View>
      <Pressable
        onPress={() => {
          haptics.tap();
          setExpanded((e) => !e);
        }}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Default region: ${currentLabel}`}
        accessibilityHint={
          expanded ? "Collapses the region list." : "Expands the region list."
        }
        accessibilityState={{ expanded, disabled }}
        style={{
          minHeight: 44,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: disabled ? t.fgSubtle : t.fg,
            ...typeStyle("callout"),
            fontFamily: FONT.regular,
          }}
        >
          Default region
        </Text>
        <Text
          {...typeCap("callout")}
          numberOfLines={1}
          style={{
            color: disabled ? t.fgSubtle : t.accent,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
            textAlign: "right",
          }}
        >
          {currentLabel}
        </Text>
      </Pressable>
      {expanded
        ? IDENTIFIER_TRANSFORM_PHONE_REGIONS.map((region) => {
            const selected = region.value === value;
            return (
              <Pressable
                key={region.value || "none"}
                onPress={() => {
                  haptics.tap();
                  onChange(region.value);
                  setExpanded(false);
                }}
                disabled={disabled}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled }}
                accessibilityLabel={region.label}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text
                  {...typeCap("body")}
                  style={{
                    color: selected ? t.accent : t.fg,
                    ...typeStyle("body"),
                    fontFamily: selected ? FONT.semibold : FONT.regular,
                  }}
                >
                  {region.label}
                </Text>
              </Pressable>
            );
          })
        : null}
    </View>
  );
}

/**
 * The preview as before → after lines. A failed preview says so — an empty,
 * reassuring preview would prove nothing — and "no change" is said in words.
 */
function PreviewLines({
  body,
  query,
}: {
  body: TransformPreviewRequest | null;
  query: ReturnType<typeof useIdentifierTransformPreview>;
}) {
  const { t } = useTheme();
  if (!body) {
    return (
      <SheetNote>Type a sample email or phone to preview the rules.</SheetNote>
    );
  }
  if (query.isError) {
    return (
      <SheetNote tone="danger">
        {errorPresentation(query.error).message || "The preview failed."}
      </SheetNote>
    );
  }
  const data = query.data;
  if (!data) {
    return (
      <SheetNote>
        {query.isLoading || query.isFetching
          ? "Previewing…"
          : "Waiting for the preview."}
      </SheetNote>
    );
  }
  const lines = [data.email, ...data.phones];
  return (
    <View style={{ gap: 6 }}>
      {lines.map((line) => (
        <View key={line.key}>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.semibold,
              textTransform: "capitalize",
            }}
          >
            {line.key}
          </Text>
          <Text
            {...typeCap("bodySmall")}
            accessibilityLabel={`${line.key}: ${previewLineText(line)}`}
            style={{
              color: line.changed ? t.fg : t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {previewLineText(line)}
          </Text>
        </View>
      ))}
      <SheetNote>Previewed against the unsaved draft — nothing is stored.</SheetNote>
    </View>
  );
}
