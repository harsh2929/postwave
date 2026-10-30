/**
 * lib/pairingClipboard.ts — what a pasted string means on the API-key sign-in
 * screen. Pure, so the whole decision table is unit-tested in node.
 *
 * WHY THIS EXISTS (MAP#63). The API-key screen asks a phone user to enter a
 * ~40-character `pw_live_…` secret by hand. The audit filed it against a stale
 * TODO pointing at a `components/PairQR.tsx` that never existed; scanning is
 * not the answer either, because nothing in this monorepo renders a credential
 * QR for a phone to read (checked: apps/web/src/components/qr-code.tsx and
 * apps/desktop's QR call sites are TOTP, form-embed and SMS codes — none of
 * them a pairing payload). A key arrives on a phone by being copied, so the
 * honest fix is a paste path, and paste needs a grammar.
 *
 * The grammar is deliberately narrow. A clipboard is full of other people's
 * data; recognising "anything with letters in it" as a credential and dropping
 * it into a secure field would be worse than typing. Only two shapes are
 * claimed, and the third arm exists so the screen can say what it saw instead
 * of "that didn't work".
 */

/** Minted as `pw_live_…` / `pw_test_…`; the body is base62-ish with `_`/`-`. */
const API_KEY_RE = /^pw_[A-Za-z0-9_-]{8,180}$/u;

/** A pasted secret longer than this is not ours; do not touch it. */
const MAX_PASTE_CHARS = 4096;

export type PairingPaste =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "baseUrl"; baseUrl: string }
  | { kind: "none"; reason: "empty" | "unrecognised" };

export function interpretPairingPaste(
  value: string | null | undefined,
): PairingPaste {
  if (typeof value !== "string") return { kind: "none", reason: "empty" };
  // Copying from a terminal or a web table routinely carries a trailing
  // newline; the user did not type it and should not have to notice it.
  const raw = value.trim();
  if (!raw) return { kind: "none", reason: "empty" };
  if (raw.length > MAX_PASTE_CHARS) {
    return { kind: "none", reason: "unrecognised" };
  }
  if (API_KEY_RE.test(raw)) return { kind: "apiKey", apiKey: raw };
  const baseUrl = asApiOrigin(raw);
  if (baseUrl) return { kind: "baseUrl", baseUrl };
  return { kind: "none", reason: "unrecognised" };
}

/**
 * The message shown beside the field after a paste. Naming what the clipboard
 * actually held is the difference between a user fixing it in one move and
 * tapping Paste three more times.
 */
export function pairingPasteMessage(paste: PairingPaste): string {
  switch (paste.kind) {
    case "apiKey":
      return "Pasted the API key from your clipboard.";
    case "baseUrl":
      return "Your clipboard held a server URL, so it went into API base URL. Copy the API key next.";
    default:
      return paste.reason === "empty"
        ? "Your clipboard is empty."
        : "Your clipboard doesn't hold a Moosewave API key (they start with pw_).";
  }
}

/**
 * Accepts only an http(s) URL with nothing that could redirect a credential:
 * no embedded username/password, no query, no fragment. Returns it without the
 * trailing slash, which is the form the rest of the app stores.
 */
function asApiOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.toString().replace(/\/+$/u, "");
}
