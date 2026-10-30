/**
 * FirewallAdminSheet — administer the signup firewall from the phone: every
 * setting, the counters, the recent events and the manual surge sweep.
 *
 * WHY. "A signup attack detected off-hours cannot be answered from the phone"
 * (docs/mobile-desktop-parity-2026-08-28.md, "Signup-firewall
 * administration"). The deliverability card already flips attack mode alone;
 * this is the general case, and it reuses that card's confirm sentence
 * (attackModeConsequence) so both surfaces describe one flip identically.
 * Desktop anchor: components/settings/FirewallSection.tsx.
 *
 * ONLY CHANGED FIELDS TRAVEL (firewallPatch). Number fields are typed as text
 * and parsed as whole numbers; a field that does not parse keeps its own
 * message and blocks the save rather than being coerced to 0 and quietly
 * passing the server's lower bound.
 *
 * RE-SEEDS FROM THE SERVER. The saved row is a prop; when its values change —
 * a save answered, or the surge sweep armed attack mode — the draft is
 * rebuilt from it. Keyed on the values, so a refetch that changes nothing
 * does not clobber an edit in progress (as ExportRetentionCard does).
 *
 * ROLE. PUT and POST /detect are admin; the reads are viewer. Below admin the
 * form is disabled with the rule stated, and the activity still renders.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import {
  SettingsSwitchRow,
  SettingsTextInput,
} from "@/components/settings/FormControls";
import { FirewallActivity } from "@/components/settings/platform-config/FirewallActivity";
import {
  SheetButton,
  SheetGroup,
  SheetHeader,
  SheetNote,
  type SheetNoteTone,
} from "@/components/settings/platform-config/PlatformConfigPrimitives";
import { useToast } from "@/components/Toast";
import {
  useRunFirewallDetect,
  useSaveFirewallSettings,
} from "@/hooks/useFirewallAdmin";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  ADMIN_ONLY_NOTE,
  useCanAdminPlatformConfig,
} from "@/hooks/usePlatformConfigRole";
import { errorPresentation } from "@/lib/errorCopy";
import {
  firewallDraftFrom,
  firewallPatch,
  firewallPatchLines,
  parseIntField,
  surgeResultCopy,
  validateFirewallDraft,
  type FirewallDraft,
} from "@/lib/firewallAdmin";
import { dateTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import type { FirewallSettingsView } from "@/lib/platformConfig";
import { attackModeConsequence } from "@/lib/reputationResponse";

export interface FirewallAdminSheetProps {
  visible: boolean;
  /** The saved settings row; null while the card has none. */
  server: FirewallSettingsView | null;
  onClose: () => void;
}

export function FirewallAdminSheet({
  visible,
  server,
  onClose,
}: FirewallAdminSheetProps) {
  const open = visible && server !== null;
  return (
    <KeyboardFormSheet
      visible={open}
      onClose={onClose}
      accessibilityLabel="Signup firewall"
      contentContainerStyle={{ paddingTop: 12 }}
    >
      <SheetHeader
        title="Signup firewall"
        subtitle="Moosewave's defence against bot signups on your forms."
        onClose={onClose}
        closeLabel="Close signup firewall"
      />
      {open && server ? <FirewallBody server={server} /> : null}
    </KeyboardFormSheet>
  );
}

type NumberField = "attackModeThreshold" | "surgeMultiplier" | "surgeMinPerHour";
type BoolField = "attackModeEnabled" | "autoAttackMode" | "fingerprintRequired";

/** Bounds in the hints are the server's (FIREWALL_BOUNDS); the rule prose is
 *  the card's own surgeRuleLabel, restated per field. */
const NUMBER_FIELDS: readonly {
  key: NumberField;
  label: string;
  hint: string;
}[] = [
  {
    key: "attackModeThreshold",
    label: "Block score",
    hint: "Whole number from 0 to 100.",
  },
  {
    key: "surgeMultiplier",
    label: "Surge multiplier",
    hint: "Arms above this many times the usual signup rate (2 to 100).",
  },
  {
    key: "surgeMinPerHour",
    label: "Surge minimum per hour",
    hint: "Never arms below this many signups an hour (1 to 100,000).",
  },
];

function textFrom(draft: FirewallDraft): Record<NumberField, string> {
  return {
    attackModeThreshold: String(draft.attackModeThreshold),
    surgeMultiplier: String(draft.surgeMultiplier),
    surgeMinPerHour: String(draft.surgeMinPerHour),
  };
}

function serverSignature(s: FirewallSettingsView): string {
  return [
    s.attackModeEnabled,
    s.autoAttackMode,
    s.fingerprintRequired,
    s.attackModeThreshold,
    s.surgeMultiplier,
    s.surgeMinPerHour,
  ].join("/");
}

function FirewallBody({ server }: { server: FirewallSettingsView }) {
  const canAdmin = useCanAdminPlatformConfig();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const save = useSaveFirewallSettings();
  const detect = useRunFirewallDetect();

  const [serverDraft, setServerDraft] = useState(() => firewallDraftFrom(server));
  const [draft, setDraft] = useState(serverDraft);
  const [text, setText] = useState(() => textFrom(serverDraft));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [detectNote, setDetectNote] = useState<{
    tone: SheetNoteTone;
    text: string;
  } | null>(null);

  const signature = serverSignature(server);
  useEffect(() => {
    const next = firewallDraftFrom(server);
    setServerDraft(next);
    setDraft(next);
    setText(textFrom(next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const unparsed = NUMBER_FIELDS.find(
    (field) => parseIntField(text[field.key]) === null,
  );
  const validation = unparsed
    ? `${unparsed.label} must be a whole number.`
    : validateFirewallDraft(draft);
  const patch = firewallPatch(serverDraft, draft);
  const offline = !gate.enabled;
  const busy = save.isPending || detect.isPending;
  const locked = !canAdmin || busy;

  function setBool(key: BoolField, value: boolean) {
    setDraft((d) => ({ ...d, [key]: value }));
  }
  function setNumber(key: NumberField, value: string) {
    setText((current) => ({ ...current, [key]: value }));
    const n = parseIntField(value);
    if (n !== null) setDraft((d) => ({ ...d, [key]: n }));
  }

  async function onSave() {
    if (!patch || locked || validation || offline) return;
    haptics.tap();
    const arming = patch.attack_mode_enabled;
    const ok = await confirm({
      title:
        arming === undefined
          ? "Save firewall settings?"
          : arming
            ? "Turn on attack mode?"
            : "Turn off attack mode?",
      ...(arming === undefined ? {} : { message: attackModeConsequence(arming) }),
      consequence: firewallPatchLines(patch).join("\n"),
      confirmLabel:
        arming === undefined ? "Save" : arming ? "Turn on" : "Turn off",
      destructive: arming === true,
    });
    if (!ok) return;
    setSaveError(null);
    save.mutate(patch, {
      onSuccess: () => {
        toast({ kind: "success", message: "Firewall settings saved." });
      },
      onError: (err) => {
        const message =
          errorPresentation(err).message || "Couldn't save the firewall settings.";
        setSaveError(message);
        toast({ kind: "error", message });
      },
    });
  }

  function onDetect() {
    if (locked || offline) return;
    haptics.tap();
    detect.mutate(undefined, {
      onSuccess: ({ flipped }) => {
        // The server's answer, in desktop's two sentences — never a detail
        // the sweep did not report.
        setDetectNote({
          tone: flipped ? "warning" : "muted",
          text: surgeResultCopy(flipped),
        });
        toast({ kind: flipped ? "warning" : "info", message: surgeResultCopy(flipped) });
      },
      onError: (err) => {
        const message =
          errorPresentation(err).message || "Couldn't run the surge check.";
        setDetectNote({ tone: "danger", text: message });
        toast({ kind: "error", message });
      },
    });
  }

  return (
    <View>
      {!canAdmin ? <SheetNote>{ADMIN_ONLY_NOTE}</SheetNote> : null}
      {offline ? (
        <SheetNote tone="warning">
          You’re offline — settings can be read but not changed until you reconnect.
        </SheetNote>
      ) : null}
      <SheetGroup title="Attack mode">
        <SettingsSwitchRow
          label="Attack mode"
          hint="Strictest signup checks. Turning it off holds the automatic detector back for 24 hours."
          value={draft.attackModeEnabled}
          disabled={locked}
          onValueChange={(v) => setBool("attackModeEnabled", v)}
        />
        {server.autoEnabledAt ? (
          <SheetNote tone="warning">
            {`Escalated automatically ${dateTime(server.autoEnabledAt)}.`}
          </SheetNote>
        ) : null}
        <SettingsSwitchRow
          label="Automatic escalation"
          hint="Arms attack mode on its own when signups surge past the thresholds below."
          value={draft.autoAttackMode}
          disabled={locked}
          onValueChange={(v) => setBool("autoAttackMode", v)}
        />
        <SettingsSwitchRow
          label="Require a browser fingerprint"
          hint="Signups must carry a browser fingerprint."
          value={draft.fingerprintRequired}
          disabled={locked}
          onValueChange={(v) => setBool("fingerprintRequired", v)}
        />
      </SheetGroup>
      <SheetGroup title="Thresholds">
        {NUMBER_FIELDS.map((field) => (
          <SettingsTextInput
            key={field.key}
            label={field.label}
            hint={field.hint}
            value={text[field.key]}
            onChangeText={(v) => setNumber(field.key, v)}
            keyboardType="number-pad"
            editable={!locked}
          />
        ))}
        {validation ? <SheetNote tone="danger">{validation}</SheetNote> : null}
      </SheetGroup>
      {saveError ? <SheetNote tone="danger">{saveError}</SheetNote> : null}
      {canAdmin ? (
        <View style={{ flexDirection: "row", gap: 10, marginBottom: 12 }}>
          <SheetButton
            label={detect.isPending ? "Checking…" : "Check for surge now"}
            tone="neutral"
            disabled={locked || offline}
            onPress={onDetect}
            accessibilityHint="Runs the surge sweep now and reports whether attack mode was armed."
          />
          <SheetButton
            label={save.isPending ? "Saving…" : "Save settings"}
            tone="primary"
            disabled={!patch || Boolean(validation) || locked || offline}
            onPress={() => void onSave()}
            accessibilityHint="Asks for confirmation before saving."
          />
        </View>
      ) : null}
      {detectNote ? (
        <View style={{ marginBottom: 12 }}>
          <SheetNote tone={detectNote.tone}>{detectNote.text}</SheetNote>
        </View>
      ) : null}
      <FirewallActivity enabled />
    </View>
  );
}
