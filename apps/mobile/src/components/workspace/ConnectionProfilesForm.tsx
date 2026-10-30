/**
 * AddConnectionForm — "add a workspace" for a SERVER, not a tenant.
 *
 * Desktop's dialog has three fields (name, API URL, optional API key); this
 * has two, because mobile deliberately stores no per-profile credential (see
 * lib/connectionProfiles.ts for why that is the safer trade on a device whose
 * only credential store is wiped on sign-out).
 *
 * The URL field comes FIRST and seeds the name from the host, so the common
 * case is one paste and one tap. A name the user has typed is never
 * overwritten by a later URL edit.
 *
 * Every refusal comes from `connectionProfileProblem` by way of the
 * controller, so the URL policy the sign-in screen enforces and the one this
 * form enforces are the same function — a server this form accepted could
 * otherwise be one sign-in refuses to talk to.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { useToast } from "@/components/Toast";
import type { ConnectionProfilesController } from "@/hooks/useConnectionProfiles";
import { announce } from "@/lib/a11y";
import {
  MAX_PROFILE_NAME_CHARS,
  suggestConnectionName,
} from "@/lib/connectionProfiles";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export function AddConnectionForm({
  controller,
}: {
  controller: ConnectionProfilesController;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [url, setUrl] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const refusal = await controller.add({ name, baseUrl: url });
      if (refusal) {
        haptics.error();
        setProblem(refusal.message);
        announce(refusal.message);
        return;
      }
      haptics.success();
      const saved = name.trim();
      toast({
        kind: "success",
        message: `Saved “${saved}”. Switch to it when you're ready to sign in.`,
      });
      announce(`Saved ${saved}`);
      setName("");
      setNameTouched(false);
      setUrl("");
      setProblem(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ marginTop: 20, gap: 12 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          fontFamily: FONT.semibold,
          ...typeStyle("bodySmall"),
        }}
      >
        Add a connection
      </Text>
      <Field
        label="API URL"
        value={url}
        placeholder="https://api.acme.com"
        accessibilityLabel="Server API URL"
        autoCapitalize="none"
        onChangeText={(next) => {
          setUrl(next);
          setProblem(null);
          // The host is the only name we actually know; a name the user typed
          // is never overwritten.
          if (!nameTouched) setName(suggestConnectionName(next));
        }}
      />
      <Field
        label="Name"
        value={name}
        placeholder="Acme production"
        accessibilityLabel="Connection name"
        maxLength={MAX_PROFILE_NAME_CHARS}
        onChangeText={(next) => {
          setNameTouched(true);
          setName(next);
          setProblem(null);
        }}
      />
      {problem ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("label")}
          style={{
            color: t.warning,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {problem}
        </Text>
      ) : null}
      <Pressable
        onPress={() => void submit()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Save this connection"
        accessibilityState={{ disabled: busy }}
        style={{
          minHeight: 48,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: t.accent,
          opacity: busy ? 0.45 : 1,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: t.accentFg,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {busy ? "Saving…" : "Save connection"}
        </Text>
      </Pressable>
    </View>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  autoCapitalize?: "none";
  maxLength?: number;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        {props.label}
      </Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel={props.accessibilityLabel}
        returnKeyType="done"
        maxLength={props.maxLength ?? 512}
        {...(props.autoCapitalize
          ? {
              autoCapitalize: props.autoCapitalize,
              autoCorrect: false,
              keyboardType: "url" as const,
            }
          : {})}
        {...typeCap("body")}
        style={{
          color: t.fg,
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
          fontSize: fontSizeFor("body"),
          fontFamily: FONT.regular,
          minHeight: 44,
        }}
      />
    </View>
  );
}
