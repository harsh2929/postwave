/**
 * lib/assetUploadPolicy.ts — may this image be uploaded, and what will the
 * server call it.
 *
 * Import-free on purpose (no react-native, no expo), so every decision below is
 * exercised in the node vitest environment rather than asserted by hand in a
 * render test — the pattern used by lib/approvalPolicy, lib/feedbackPolicy and
 * lib/templatePolicy.
 *
 * WHY THE PHONE DECIDES ANY OF THIS. `POST /api/v1/assets` refuses an upload in
 * three different ways, and all three arrive AFTER the bytes have been pushed
 * over a mobile connection:
 *
 *   - `errTooBig`      → 422 `validation_failed` once the body exceeds
 *                        `MaxBytes` = 10 MiB (image.go:18, :78).
 *   - `errBadType`     → 422 `validation_failed` for anything that is not a
 *                        complete PNG / JPEG / GIF / WebP (image.go:90).
 *   - `payload_too_large` → 413 before parsing, when the JSON envelope exceeds
 *                        `assetJSONMaxBodyBytes` = 20 MiB (handlers.go:142).
 *
 * A 12 MB photo therefore costs a full upload on cellular data to be told no.
 * Every rule here is the server's own rule, evaluated before a byte moves.
 *
 * THE SERVER IGNORES THE DECLARED MIME. `UploadBytes` takes the declared type
 * as `_` (handlers.go:196) and uses only the sniffed one, so the `mime` field
 * in the request body is documentation, not instruction. That is exactly why
 * this module sniffs the bytes itself rather than trusting
 * `ImagePickerAsset.mimeType` — on iOS the picker's `base64` field is re-encoded
 * JPEG data while `mimeType` can still describe the original HEIC, and
 * rejecting on the declared type would refuse an upload the server would have
 * accepted.
 */

/** `MaxBytes` — image.go:18. The decoded image, not the base64 envelope. */
export const ASSET_MAX_BYTES = 10 * 1024 * 1024;

/** What `validateAndSanitizeImage` accepts (image.go:90-176). */
export const ASSET_UPLOAD_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type AssetUploadMime = (typeof ASSET_UPLOAD_MIMES)[number];

/* ------------------------------------------------------------------ *
 * base64
 * ------------------------------------------------------------------ */

const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function sextet(character: string): number {
  const std = STD.indexOf(character);
  if (std >= 0) return std;
  // `DecodeBase64` (util.go:11) tries std, raw-std, URL and raw-URL in turn, so
  // both alphabets are legal input and the two only differ in two characters.
  return URL_SAFE.indexOf(character);
}

/**
 * Exactly the characters JavaScript's `\s` matches — ECMA-262 WhiteSpace plus
 * LineTerminator.
 *
 * Spelled out rather than tested with a regex so `decodeBase64Prefix` below can
 * skip whitespace INSIDE its scan instead of stripping it beforehand. It used
 * to open with `.replace(/\s+/g, "")` over a payload that can be 13.4 MB, to
 * then read 22 characters of it.
 *
 * `base64ByteLength` deliberately does NOT use this. The obvious symmetric
 * rewrite — count the non-whitespace characters in a JS loop — was written,
 * measured, and thrown away: at the 10 MiB cap it ran 25.7 ms against the
 * `replace` form's 3.5 ms, because a whitespace-free `replace` is a C++ scan
 * that returns the receiver without copying, and 14 million `charCodeAt` calls
 * are not.
 */
function isJsWhitespace(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/**
 * Exact decoded length of a base64 payload, without materialising the bytes.
 *
 * Length is what the size gate needs, and a 10 MiB image is ~13.4 MiB of
 * base64 — decoding it just to call `.length` would double the peak memory of
 * the one operation on this screen that is already the most memory-hungry.
 *
 * The `replace` stays: on a payload with no whitespace (which is every payload
 * the picker produces) it allocates nothing and the scan is native. See the
 * note on `isJsWhitespace` for the hand-rolled version that was measured and
 * rejected.
 */
export function base64ByteLength(value: string | null | undefined): number {
  const clean = (value ?? "").replace(/\s+/g, "");
  let end = clean.length;
  while (end > 0 && clean[end - 1] === "=") end -= 1;
  if (end === 0) return 0;
  return Math.floor((end * 3) / 4);
}

/**
 * Decode at most `maxBytes` leading bytes. Enough to read a file signature and
 * nothing more — the whole point is to avoid touching the other 13 MB.
 *
 * Whitespace is skipped IN the scan rather than stripped ahead of it, which is
 * what makes the promise in that sentence true: the loop returns after ~22
 * characters, so the other 13 MB is genuinely never read. It was, before.
 */
export function decodeBase64Prefix(
  value: string | null | undefined,
  maxBytes: number,
): number[] {
  const raw = value ?? "";
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (isJsWhitespace(code)) continue;
    if (code === 0x3d /* = */) break;
    const character = raw[index] as string;
    const sextetIndex = sextet(character);
    if (sextetIndex < 0) return out;
    buffer = (buffer << 6) | sextetIndex;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      if (out.length >= maxBytes) return out;
    }
  }
  return out;
}

function matches(bytes: readonly number[], at: number, ascii: string): boolean {
  for (let i = 0; i < ascii.length; i += 1) {
    if (bytes[at + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * The same signature checks `validateAndSanitizeImage` opens with: the PNG
 * 8-byte magic, the JPEG SOI marker, the GIF header, and RIFF….WEBP. It is a
 * pre-filter, never a verdict — the server still runs a complete decode, and
 * an image that passes here can still be refused as structurally broken.
 */
export function sniffAssetMime(
  bytes: readonly number[],
): AssetUploadMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    matches(bytes, 1, "PNG\r\n") &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && matches(bytes, 0, "GIF8")) return "image/gif";
  if (bytes.length >= 12 && matches(bytes, 0, "RIFF") && matches(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

export type AssetUploadRejection =
  | "not_an_image"
  | "no_data"
  | "too_large"
  | "unsupported_type";

export interface AssetUploadCandidate {
  /** `ImagePickerAsset.base64` — present only when `base64: true` was asked for. */
  base64?: string | null | undefined;
  /** `ImagePickerAsset.fileName`. */
  fileName?: string | null | undefined;
  /** `ImagePickerAsset.type` — 'image' | 'video' | 'livePhoto' | 'pairedVideo'. */
  kind?: string | null | undefined;
}

export interface AssetUploadDecision {
  ok: boolean;
  reason: AssetUploadRejection | null;
  /** Empty when `ok`. A whole sentence, shown in a toast. */
  message: string;
  /** Decoded size in bytes. 0 when there was nothing to measure. */
  bytes: number;
  /** The sniffed type, which is what the server will store it as. */
  mime: AssetUploadMime | null;
}

/**
 * Human size using the same 1024 base the server's `MaxBytes` uses. Kept local
 * rather than reusing lib/format.bytes so this module stays import-free.
 */
export function assetSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KB`;
  const mib = kib / 1024;
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MB`;
}

/** Shared with lib/assetErrors so a refusal reads the same before and after. */
export const ASSET_ACCEPTED_SENTENCE =
  "PNG, JPEG, GIF and WebP images are accepted.";
const ACCEPTED_SENTENCE = ASSET_ACCEPTED_SENTENCE;

/**
 * Evaluate a picked asset against the server's upload contract.
 *
 * Order matters and mirrors the server's: the media kind first (a video has no
 * business reaching an image decoder), then emptiness (`errEmpty`), then size
 * (`errTooBig`), then format (`errBadType`). Reporting the FIRST failure in
 * that order means the message names the thing the operator can act on.
 */
export function evaluateAssetUpload(
  candidate: AssetUploadCandidate,
): AssetUploadDecision {
  const kind = (candidate.kind ?? "").trim().toLowerCase();
  if (kind && kind !== "image") {
    return {
      ok: false,
      reason: "not_an_image",
      message: `The asset library holds images only, and that is a ${kind}. ${ACCEPTED_SENTENCE}`,
      bytes: 0,
      mime: null,
    };
  }
  const bytes = base64ByteLength(candidate.base64);
  if (bytes === 0) {
    return {
      ok: false,
      reason: "no_data",
      message:
        "Your phone didn't hand over any image data for that pick. Try choosing it again.",
      bytes: 0,
      mime: null,
    };
  }
  if (bytes > ASSET_MAX_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      message: `That image is ${assetSizeLabel(bytes)}. The library accepts images up to ${assetSizeLabel(ASSET_MAX_BYTES)}.`,
      bytes,
      mime: null,
    };
  }
  const mime = sniffAssetMime(decodeBase64Prefix(candidate.base64, 16));
  if (!mime) {
    return {
      ok: false,
      reason: "unsupported_type",
      message: `That file isn't a format the library can store. ${ACCEPTED_SENTENCE}`,
      bytes,
      mime: null,
    };
  }
  return { ok: true, reason: null, message: "", bytes, mime };
}

/* ------------------------------------------------------------------ *
 * The stored filename
 * ------------------------------------------------------------------ */

const EXT_FOR_MIME: Record<AssetUploadMime, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** `filepath.Base` on a slash-separated path, including its edge cases. */
function goBase(path: string): string {
  if (path === "") return ".";
  let value = path;
  while (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  if (value === "/") return "/";
  const cut = value.lastIndexOf("/");
  return cut >= 0 ? value.slice(cut + 1) : value;
}

/**
 * What the server will actually store the file as — `sanitizeAssetFilename`
 * (handlers.go:561) reproduced exactly, so the confirm sheet can show the name
 * before the upload instead of after it.
 *
 * Two details that a looser reimplementation gets wrong:
 *   - THE CALLER'S EXTENSION IS ALWAYS DISCARDED and replaced with the one the
 *     DECODER confirmed, so `logo.png` holding JPEG bytes is stored as
 *     `logo.jpg`. The stored name never advertises a type the bytes are not.
 *   - THE 128 CAP IS COUNTED IN BYTES. After the character filter the name is
 *     pure ASCII, so a JavaScript `.length` and Go's `len` agree here — but
 *     only because the filter runs first.
 */
export function assetStoredFilename(
  name: string | null | undefined,
  mime: AssetUploadMime | null,
): string {
  let base = goBase((name ?? "").trim());
  if (base === "" || base === "." || base === "/" || base === "\\") {
    base = "upload";
  }
  const dot = base.lastIndexOf(".");
  if (dot > -1) base = base.slice(0, dot);
  let out = "";
  // Per CODE POINT, matching Go's `for _, r := range name`: one underscore per
  // rejected rune, so an emoji becomes one "_" rather than two.
  for (const character of base) {
    out += /^[A-Za-z0-9.\-_]$/.test(character) ? character : "_";
  }
  while (out.includes("..")) out = out.replaceAll("..", ".");
  out = out.replace(/^\.+/, "");
  if (out === "") out = "upload";
  const ext = mime ? EXT_FOR_MIME[mime] : "";
  if (out.length > 128 - ext.length) out = out.slice(0, 128 - ext.length);
  return out + ext;
}
