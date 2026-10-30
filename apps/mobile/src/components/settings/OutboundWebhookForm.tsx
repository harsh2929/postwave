/**
 * OutboundWebhookForm — the create AND edit form for an outbound webhook.
 *
 * Split out of `OutboundWebhooksSection` so three fixes could land without the
 * section growing past its size budget:
 *
 *  - URL VALIDATION. `submit()` used to check only that the string was
 *    non-empty, so "example.com/hooks" (no scheme) cost a round trip and came
 *    back as an opaque server error — or created an endpoint that silently
 *    never delivered. `validateWebhookUrl` fast-fails what is definitely
 *    unusable and WARNS (never blocks) on plain http or a private host, both of
 *    which are legitimate against a dev tunnel. The server stays the authority.
 *  - THE EVENT CHIPS COME FROM THE SERVER. The hardcoded client list had
 *    already drifted two entries behind `AllowedEvents`, so two event types the
 *    backend accepts could not be subscribed to from a phone.
 *  - RECEIVER TEMPLATES. Desktop opens this form FROM a gallery of named
 *    receivers (Zapier, Make, n8n, Discord, Teams, your own server); the phone
 *    had none, so every field was typed from scratch. `ReceiverPresetGallery`
 *    sits above the fields on the CREATE path only and fills them in place —
 *    it never submits, and it never invents a destination URL. Rules and copy:
 *    lib/receiverPresets.
 *  - OFFLINE IS BLOCKED, DELIBERATELY, RATHER THAN QUEUED. This mutation
 *    returns a reveal-once signing secret; replaying it from the offline queue
 *    hours later would mint a secret nobody is looking at. So the button is
 *    disabled with an explanation instead of failing with a raw network error.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { Chip } from "@/components/Chip";
import { ReceiverPresetGallery } from "@/components/settings/ReceiverPresetGallery";
import { FONT } from "@/lib/fonts";
import { validateWebhookUrl } from "@/lib/outboundWebhookForm";
import {
  applyReceiverPreset,
  receiverPresetNotes,
  type ReceiverPreset,
} from "@/lib/receiverPresets";
import { useDirtyGuard } from "@/hooks/useDirtyGuard";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardChain } from "@/lib/keyboardChain";

export interface OutboundWebhookDraft {
  url: string;
  description: string;
  events: string[];
}

export interface OutboundWebhookFormProps {
  /** Event types the server accepts, already resolved from the catalog. */
  catalog: readonly string[];
  /** A submit is in flight. */
  creating: boolean;
  online: boolean;
  onCancel: () => void;
  onCreate: (draft: OutboundWebhookDraft) => void;
  /**
   * Present when EDITING an existing endpoint. The fields open pre-filled and
   * the dirty guard compares against these values, so leaving an untouched
   * edit form does not warn.
   */
  initial?: OutboundWebhookDraft | undefined;
  /** "Create" by default; "Save" when editing. */
  submitLabel?: string;
  /** Label while the submit is in flight. */
  pendingLabel?: string;
  /**
   * Editing does NOT mint a signing secret, so the offline block below only
   * needs its reveal-once justification on the create path.
   */
  offlineReason?: string;
}

export function OutboundWebhookForm({
  catalog,
  creating,
  online,
  onCancel,
  onCreate,
  initial,
  submitLabel = "Create",
  pendingLabel = "Creating…",
  offlineReason = "Needs a connection — a signing secret is shown only once, so this can’t be queued for later.",
}: OutboundWebhookFormProps) {
  const { t } = useTheme();
  const [url, setUrl] = useState(initial?.url ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [events, setEvents] = useState<string[]>(initial?.events ?? []);
  const [touchedUrl, setTouchedUrl] = useState(false);
  // The receiver template applied to this draft, if any. It is a STARTING
  // POINT, not a mode: every field it filled stays editable, and the only
  // thing it changes about submit is what the fields happen to contain.
  const [preset, setPreset] = useState<ReceiverPreset | null>(null);
  const [presetNotes, setPresetNotes] = useState<readonly string[]>([]);

  const pickPreset = (next: ReceiverPreset) => {
    const applied = applyReceiverPreset(
      { url, description, events },
      next,
      catalog,
    );
    // Every field the template can touch is written back from the SAME
    // application, including the URL it deliberately leaves alone — so the
    // rules live in one place instead of half here and half in the lib.
    setUrl(applied.draft.url);
    setDescription(applied.draft.description);
    setEvents(applied.draft.events);
    setPreset(next);
    setPresetNotes(receiverPresetNotes(applied));
  };

  const check = useMemo(() => validateWebhookUrl(url), [url]);
  // Do not shout at someone mid-type; the error appears once they leave the
  // field or press Create.
  const urlError = touchedUrl && !check.ok ? check.message : null;
  const urlWarning = check.ok ? (check.warning ?? null) : null;
  const noEvents = events.length === 0;

  const blocked = !online || creating;

  // The form only counts as dirty once something has actually been typed or
  // picked — an empty open form should not warn on the way out, or the guard
  // becomes the thing users learn to dismiss without reading.
  useDirtyGuard(
    "outbound-webhook-form",
    initial ? "Webhook changes" : "New webhook",
    initial
      ? url.trim() !== initial.url.trim() ||
          description.trim() !== initial.description.trim() ||
          !sameEvents(events, initial.events)
      : url.trim().length > 0 ||
          description.trim().length > 0 ||
          events.length > 0,
  );

  const descriptionRef = useRef<TextInput>(null);

  const submit = () => {
    setTouchedUrl(true);
    if (!check.ok || noEvents || blocked) return;
    onCreate({ url: check.url, description: description.trim(), events });
  };

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 10,
      }}
    >
      {/* Create only. An endpoint that already exists has a destination and a
          history; "start from a receiver" is not a thing to offer it. */}
      {initial ? null : (
        <ReceiverPresetGallery
          selected={preset}
          notes={presetNotes}
          onPick={pickPreset}
        />
      )}

      <TextInput
        // Inputs scale with the OS text size but their height does not — cap it.
        {...typeCap("body")}
        value={url}
        onChangeText={setUrl}
        onBlur={() => setTouchedUrl(true)}
        placeholder={
          preset?.urlPlaceholder ?? "https://example.com/webhooks/postwave"
        }
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Webhook URL"
        accessibilityHint="Destination URL that receives outbound Moosewave webhook events."
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        {...keyboardChain({ next: descriptionRef })}
        style={{
          backgroundColor: t.bgSubtle,
          borderColor: urlError ? t.danger : t.border,
          borderWidth: 1,
          color: t.fg,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 9,
          fontSize: fontSizeFor("callout"),
          minHeight: 44,
        }}
      />
      {urlError ? <Note tone="danger">{urlError}</Note> : null}
      {!urlError && urlWarning ? <Note tone="warning">{urlWarning}</Note> : null}

      <TextInput
        // Inputs scale with the OS text size but their height does not — cap it.
        {...typeCap("body")}
        ref={descriptionRef}
        value={description}
        onChangeText={setDescription}
        placeholder="Description (optional)"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Webhook description"
        accessibilityHint="Optional label for this outbound webhook."
        {...keyboardChain({ onSubmit: submit, disabled: blocked })}
        style={{
          backgroundColor: t.bgSubtle,
          borderColor: t.border,
          borderWidth: 1,
          color: t.fg,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 9,
          fontSize: fontSizeFor("callout"),
          minHeight: 44,
        }}
      />

      <Text
        accessibilityRole="header"
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Event types
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {catalog.map((ev) => (
          <Chip
            key={ev}
            label={ev}
            active={events.includes(ev)}
            accessibilityLabel={`${ev} event`}
            onPress={() =>
              setEvents((prev) =>
                prev.includes(ev)
                  ? prev.filter((e) => e !== ev)
                  : [...prev, ev],
              )
            }
          />
        ))}
      </View>
      {noEvents ? (
        <Note tone="muted">Pick at least one event to subscribe to.</Note>
      ) : null}

      {online ? null : <Note tone="warning">{offlineReason}</Note>}

      <View style={{ flexDirection: "row", gap: 8 }}>
        <FormButton
          label="Cancel"
          onPress={onCancel}
          disabled={creating}
          tone="neutral"
        />
        <FormButton
          label={creating ? pendingLabel : submitLabel}
          onPress={submit}
          disabled={blocked || noEvents}
          tone="primary"
        />
      </View>
    </View>
  );
}

/** Order-insensitive comparison — the chips do not preserve a stable order. */
function sameEvents(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(b);
  return a.every((value) => seen.has(value));
}

function Note({
  tone,
  children,
}: {
  tone: "danger" | "warning" | "muted";
  children: string;
}) {
  const { t } = useTheme();
  const color =
    tone === "danger" ? t.danger : tone === "warning" ? t.warning : t.fgMuted;
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

function FormButton({
  label,
  onPress,
  disabled,
  tone,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  tone: "primary" | "neutral";
}) {
  const { t } = useTheme();
  const primary = tone === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        flex: 1,
        borderRadius: 10,
        borderWidth: primary ? 0 : 1,
        borderColor: t.border,
        backgroundColor: primary ? t.accent : t.bgSubtle,
        alignItems: "center",
        justifyContent: "center",
        minHeight: 44,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: primary ? t.accentFg : t.fg,
          fontWeight: primary ? "700" : "600",
          fontFamily: primary ? FONT.bold : FONT.semibold,
          ...typeStyle("callout"),
        }}
        {...typeCap("callout")}
      >
        {label}
      </Text>
    </Pressable>
  );
}
