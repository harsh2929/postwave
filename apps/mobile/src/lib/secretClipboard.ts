/**
 * A clipboard copy that expires — for one-time secrets only.
 *
 * The security review found the webhook signing secret sits on the iOS general
 * pasteboard with no expiry and no `localOnly`, so Universal Clipboard hands it
 * to every paired Mac on the same Apple ID and it stays there until something
 * else is copied. `expo-clipboard` exposes neither `UIPasteboard`'s
 * `expirationDate` nor its `localOnly` option, so the platform's own mechanism
 * is out of reach and the timer has to live in JS.
 *
 * WHY NOT CLEAR ON DISMISS: the operator copies the secret in order to paste it
 * somewhere else, and dismissing the sheet is usually the step BEFORE the
 * paste. Clearing there destroys the thing they asked for. A delay is what
 * password managers do, and 90 seconds is their usual figure — long enough to
 * switch apps and paste, short enough that the secret is not still sitting in
 * a shared pasteboard an hour later.
 *
 * THE CLEAR IS CONDITIONAL, ALWAYS. It fires only when the clipboard still
 * holds the exact value we put there. If the operator has copied anything else
 * in the meantime, that copy is theirs and we leave it alone — a self-clearing
 * secret that eats an unrelated clipboard is a worse bug than the one it fixes.
 *
 * ANDROID READS CAN FAIL BY DESIGN. From Android 10, an app that is not in the
 * foreground cannot read the clipboard at all; `getStringAsync` resolves empty
 * rather than throwing. An empty read is indistinguishable from "the operator
 * cleared it", and both mean "do not write" — so the timer simply declines to
 * act, and the AppState subscription below retries the moment the app is
 * foregrounded again, which is the first instant the read is permitted.
 */
import { AppState, type AppStateStatus } from "react-native";
import * as Clipboard from "expo-clipboard";

export const SECRET_CLIPBOARD_TTL_MS = 90_000;

/** Cancels the pending expiry. Idempotent. */
export type CancelSecretCopy = () => void;

const NOOP_CANCEL: CancelSecretCopy = () => {};

/**
 * Copy `value`, then clear it after `ttlMs` if it is still on the clipboard.
 *
 * Resolves the same boolean `copyToClipboard` does — whether the WRITE landed —
 * so callers keep treating a failed copy as "not captured". The expiry is
 * scheduled only on a successful write.
 */
export async function copySecretToClipboard(
  value: string,
  ttlMs: number = SECRET_CLIPBOARD_TTL_MS,
): Promise<{ copied: boolean; cancel: CancelSecretCopy }> {
  let copied: boolean;
  try {
    copied = await Clipboard.setStringAsync(value);
  } catch {
    return { copied: false, cancel: NOOP_CANCEL };
  }
  if (!copied) return { copied: false, cancel: NOOP_CANCEL };
  return { copied: true, cancel: scheduleExpiry(value, ttlMs) };
}

function scheduleExpiry(value: string, ttlMs: number): CancelSecretCopy {
  let settled = false;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let subscription: { remove: () => void } | null = null;

  // One exit for every path. The AppState subscription outlives the component
  // that started the copy — deliberately, so closing the sheet does not cancel
  // the expiry — which makes it this module's job to take the listener back
  // down, whichever way the copy ends.
  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    subscription?.remove();
    subscription = null;
  };

  const clearIfUnchanged = async (): Promise<void> => {
    if (settled) return;
    let current: string;
    try {
      current = await Clipboard.getStringAsync();
    } catch {
      // Locked or restricted pasteboard. Not knowing what is there is not a
      // licence to overwrite it; the foreground retry gets another chance.
      return;
    }
    if (settled) return;
    if (current !== value) {
      // A non-empty mismatch means the operator copied something else. That is
      // theirs, so leave it and stand down. An EMPTY read is the ambiguous
      // one — either they cleared it, or Android refused a background read —
      // so stay armed and let the next foreground settle it.
      if (current !== "") finish();
      return;
    }
    try {
      await Clipboard.setStringAsync("");
    } catch {
      /* the secret outlives us; nothing further this layer can do */
    }
    finish();
  };

  timer = setTimeout(() => {
    expired = true;
    void clearIfUnchanged();
  }, ttlMs);

  // Backgrounding is the common case here — the operator leaves to paste — and
  // it is also when an Android read is refused. Retry on the way back in.
  subscription = AppState.addEventListener(
    "change",
    (state: AppStateStatus) => {
      if (state === "active" && expired) void clearIfUnchanged();
    },
  );

  return finish;
}
