/**
 * WebhookSecretCard — the highest-stakes ephemeral moment in the cluster.
 *
 * A signing secret is returned by the server exactly once, at create time. The
 * previous card rendered it as `selectable` text with a Done button that was
 * live immediately, and held the value in the parent's `useState` — so the
 * user's most likely next action (leave the app, open a password manager) was
 * also the action most likely to destroy it. Mobile has no rotate, so a lost
 * secret meant the webhook was unusable until someone opened a laptop.
 *
 * Four changes, in order of how much they matter:
 *
 *  1. IT SURVIVES NAVIGATION. The value lives in `lib/revealOnceSecret`, a
 *     process-memory stash that outlives this component. Leaving Settings and
 *     coming back brings the card back. It is still NEVER written to disk —
 *     no SecureStore, no vault, no query cache — and it self-evicts after ten
 *     minutes so an abandoned phone is not holding a signing key all day.
 *  2. DONE REQUIRES A CAPTURE. The dismiss button stays disabled until the
 *     operator has either handed the secret to another app or explicitly
 *     ticked "I've saved this". Dismissal is irreversible; it should cost a
 *     deliberate act, not a stray tap.
 *  3. SCREENSHOTS ARE BLOCKED WHILE IT IS UP. `expo-screen-capture` is already
 *     a dependency and costs nothing here. A secret in the camera roll is a
 *     secret in every photo backup.
 *  4. THE DEADLINE IS VISIBLE. "Disappears in 9m" is the honest version of
 *     "copy this now".
 *
 * COPY IS NOW THE PRIMARY CAPTURE. `expo-clipboard` was not a dependency when
 * this card was written, so the only route off the screen was a three-tap
 * share sheet — for a value the server will never show again. A one-tap copy
 * is the capture an operator actually performs, and a SUCCESSFUL copy counts
 * as the capture that unlocks Done (a failed clipboard write does not).
 *
 * REUSED BY INBOUND ROTATION. The same ceremony now backs
 * `POST /api/v1/inbound-webhooks/{id}/rotate`, so `title`/`description` are
 * overridable and `expectedId` scopes the card to one entity — without it the
 * single-slot stash would render an outbound create's secret on the inbound
 * screen and vice versa.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import {
  copySecretToClipboard,
  SECRET_CLIPBOARD_TTL_MS,
  type CancelSecretCopy,
} from "@/lib/secretClipboard";
import * as ScreenCapture from "expo-screen-capture";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Share, Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  clearSecret,
  peekSecret,
  secretTimeLeftMs,
  type StashedSecret,
} from "@/lib/revealOnceSecret";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

/** How often the countdown and the self-eviction check re-run. */
const TICK_MS = 15_000;

export interface WebhookSecretCardProps {
  /** Bumped by the parent after a create so the card re-reads the stash. */
  revision: number;
  onDismiss: () => void;
  /**
   * Only render when the stashed secret belongs to this entity. The stash
   * holds exactly one secret process-wide; without this scope a secret minted
   * on another screen would surface here.
   */
  expectedId?: string | undefined;
  title?: string;
  description?: string;
  /** Screen-reader sentence for the secret itself. */
  secretLabel?: string;
}

export function WebhookSecretCard({
  revision,
  onDismiss,
  expectedId,
  title = "Signing secret (shown once)",
  description,
  secretLabel = "Webhook signing secret. Save it before dismissing.",
}: WebhookSecretCardProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const [secret, setSecret] = useState<StashedSecret | null>(() => peekSecret());
  const [captured, setCaptured] = useState(false);
  const [remainingMs, setRemainingMs] = useState(() => secretTimeLeftMs());
  // Deliberately NOT cleared on unmount. The expiry has to outlive this card:
  // the operator's next move after copying is to close the sheet and paste
  // somewhere else, so cancelling here would mean the secret never expires in
  // exactly the case the timer exists for. Held only so a second copy replaces
  // the first timer instead of racing it.
  const cancelClipboardExpiry = useRef<CancelSecretCopy | null>(null);

  // Re-read the stash whenever the parent says something changed, and on
  // mount — which is what makes the card come back after a navigation.
  useEffect(() => {
    setSecret(peekSecret());
    setRemainingMs(secretTimeLeftMs());
  }, [revision]);

  useEffect(() => {
    if (!secret) return;
    const id = setInterval(() => {
      const live = peekSecret();
      setSecret(live);
      setRemainingMs(secretTimeLeftMs());
      if (!live) onDismiss();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [secret, onDismiss]);

  // Screenshot guard, scoped exactly to the window the secret is visible.
  //
  // TWO calls, not one. `preventScreenCapture` installs the secure-layer trick
  // and a screenshot observer; on iOS the app-switcher cover is a SEPARATE
  // `willResignActive` blur that only `enableAppSwitcherProtection` registers.
  // Without it, iOS snapshots this window when the app backgrounds and writes
  // the image — signing secret and all — into the app container, where a
  // filesystem-level backup or a forensic image can read it. Backgrounding is
  // precisely what this card asks the operator to do ("open a password
  // manager"), and the copy below promises the secret is never saved to the
  // device. TotpEnrollSheet already does both for the same class of value.
  // Android needs no second call: FLAG_SECURE covers its recents thumbnail.
  useEffect(() => {
    if (!secret) return;
    let released = false;
    void ScreenCapture.preventScreenCaptureAsync("outbound-webhook-secret").catch(
      () => {
        // Simulators and some Android builds reject this; it is a hardening
        // measure, never a precondition for showing the secret.
      },
    );
    if (Platform.OS === "ios") {
      void ScreenCapture.enableAppSwitcherProtectionAsync(1).catch(() => {});
    }
    return () => {
      if (released) return;
      released = true;
      void ScreenCapture.allowScreenCaptureAsync(
        "outbound-webhook-secret",
      ).catch(() => {});
      if (Platform.OS === "ios") {
        void ScreenCapture.disableAppSwitcherProtectionAsync().catch(() => {});
      }
    };
  }, [secret]);

  if (!secret) return null;
  // Scope guard: a secret minted elsewhere is not this card's to reveal.
  if (expectedId && secret.id !== expectedId) return null;

  const minutesLeft = Math.max(1, Math.ceil(remainingMs / 60_000));

  const onCopy = () => {
    haptics.tap();
    void copySecretToClipboard(secret.value)
      .then(({ copied, cancel }) => {
        if (!copied) throw new Error("clipboard write did not land");
        // Only a WRITE that resolved counts as a capture — treating a failed
        // clipboard call as one would unlock the irreversible Done button on
        // a secret the operator never actually got.
        cancelClipboardExpiry.current?.();
        cancelClipboardExpiry.current = cancel;
        setCaptured(true);
        haptics.success();
        toast({
          kind: "success",
          message: `Secret copied. It clears from the clipboard in ${Math.round(
            SECRET_CLIPBOARD_TTL_MS / 1000,
          )}s.`,
        });
      })
      .catch(() => {
        haptics.error();
        toast({
          kind: "error",
          message:
            "Couldn't reach the clipboard. Use “Save to another app”, or long-press the secret to select it.",
        });
      });
  };

  const onShare = () => {
    haptics.tap();
    void Share.share({
      message: secret.value,
      title: "Moosewave webhook signing secret",
    })
      .then((result) => {
        if (result.action === Share.sharedAction) setCaptured(true);
      })
      .catch(() => {
        toast({ kind: "error", message: "Couldn't open the share sheet." });
      });
  };

  const dismiss = () => {
    clearSecret();
    setSecret(null);
    onDismiss();
    toast({
      kind: "info",
      message: "Secret dismissed. It can't be shown again.",
    });
  };

  return (
    <View
      style={{
        backgroundColor: `${t.success}10`,
        borderColor: t.success,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 8,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
        {...typeCap("bodySmall")}
      >
        {title}
      </Text>

      <Text
        accessibilityLabel={secretLabel}
        // A signing secret the user transcribes or copies: `mono` exists for
        // exactly this, and its tight ceiling keeps the character grid intact.
        {...typeCap("mono")}
        style={{
          color: t.fg,
          ...typeStyle("mono"),
          fontFamily: "Menlo",
        }}
        selectable
      >
        {secret.value}
      </Text>

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {description ??
          "Moosewave envelope-encrypts this at rest and cannot show it again."}{" "}
        It stays here — never saved to the device — and disappears in about{" "}
        {minutesLeft}m, or when you dismiss it.
      </Text>

      <SecretButton
        label="Copy secret"
        a11y="Copy the signing secret to the clipboard"
        onPress={onCopy}
        tone="accent"
      />

      <SecretButton
        label="Save to another app"
        a11y="Share the signing secret to a password manager or another app"
        onPress={onShare}
        tone="neutral"
      />

      <Pressable
        onPress={() => {
          haptics.tap();
          setCaptured((v) => !v);
        }}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: captured }}
        accessibilityLabel="I've saved this secret"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 44,
        }}
      >
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: captured ? t.success : t.border,
            backgroundColor: captured ? t.success : "transparent",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            style={{
              color: t.bg,
              fontSize: fontSizeFor("mono"),
              fontFamily: FONT.bold,
            }}
            allowFontScaling={false}
          >
            {captured ? "✓" : ""}
          </Text>
        </View>
        <Text
          style={{
            color: t.fg,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            flex: 1,
          }}
          {...typeCap("label")}
        >
          I&apos;ve saved this secret somewhere safe
        </Text>
      </Pressable>

      <SecretButton
        label="Done"
        a11y={
          captured
            ? "Dismiss the signing secret"
            : "Dismiss is unavailable until you confirm you have saved the secret"
        }
        onPress={dismiss}
        tone="neutral"
        disabled={!captured}
      />
    </View>
  );
}

function SecretButton({
  label,
  a11y,
  onPress,
  tone,
  disabled = false,
}: {
  label: string;
  a11y: string;
  onPress: () => void;
  tone: "accent" | "neutral";
  disabled?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      style={{
        minHeight: 44,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: tone === "accent" ? t.accent : t.border,
        backgroundColor: t.surface,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        style={{
          color: tone === "accent" ? t.accent : t.fg,
          ...typeStyle("badge"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
        {...typeCap("badge")}
      >
        {label}
      </Text>
    </Pressable>
  );
}
