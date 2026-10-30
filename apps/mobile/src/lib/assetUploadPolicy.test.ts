/**
 * The upload gate is the one place on this surface where getting it wrong
 * costs the operator a full cellular upload before the refusal arrives, so
 * every rule the server applies is pinned here against the Go source.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ASSET_MAX_BYTES,
  assetSizeLabel,
  assetStoredFilename,
  base64ByteLength,
  decodeBase64Prefix,
  evaluateAssetUpload,
  sniffAssetMime,
} from "./assetUploadPolicy";

/** Encode bytes as standard padded base64 without leaning on a runtime API. */
function toBase64(bytes: readonly number[]): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += alphabet[(triple >> 18) & 63];
    out += alphabet[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[triple & 63] : "=";
  }
  return out;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const WEBP_MAGIC = [
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
];

function padded(magic: readonly number[], total: number): number[] {
  const out = [...magic];
  while (out.length < total) out.push(0x00);
  return out;
}

describe("base64ByteLength — the size the server will measure", () => {
  it("counts the DECODED bytes, not the envelope", () => {
    // 10 MiB of image is ~13.4 MiB of base64; measuring the string would
    // refuse a legal upload by a third.
    expect(base64ByteLength(toBase64([1, 2, 3]))).toBe(3);
    expect(base64ByteLength(toBase64([1, 2, 3, 4]))).toBe(4);
    expect(base64ByteLength(toBase64([1]))).toBe(1);
  });

  it("accepts the unpadded form `DecodeBase64` also accepts", () => {
    // util.go:11 tries RawStdEncoding after StdEncoding, so an unpadded body
    // is legal input and must measure the same.
    expect(base64ByteLength("QUJDRA==")).toBe(4);
    expect(base64ByteLength("QUJDRA")).toBe(4);
  });

  it("ignores whitespace and reports nothing as zero", () => {
    expect(base64ByteLength("QUJD\nRA==")).toBe(4);
    expect(base64ByteLength("")).toBe(0);
    expect(base64ByteLength(null)).toBe(0);
    expect(base64ByteLength(undefined)).toBe(0);
  });
});

describe("decodeBase64Prefix", () => {
  it("stops at the byte budget instead of decoding the whole image", () => {
    const big = toBase64(padded(PNG_MAGIC, 4096));
    expect(decodeBase64Prefix(big, 16)).toHaveLength(16);
  });

  it("decodes the url-safe alphabet too", () => {
    // 0xfb 0xef 0xbe → "++++"-class output in std, "--__"-class in url-safe.
    const bytes = [0xfb, 0xef, 0xbe];
    const std = toBase64(bytes);
    const urlSafe = std.replaceAll("+", "-").replaceAll("/", "_");
    expect(decodeBase64Prefix(urlSafe, 8)).toEqual(bytes);
  });

  it("returns what it has when the payload turns to garbage", () => {
    expect(decodeBase64Prefix("QUJD!!!!", 8)).toEqual([65, 66, 67]);
  });
});

describe("sniffAssetMime — the four formats image.go will decode", () => {
  it("recognises each accepted signature", () => {
    expect(sniffAssetMime(PNG_MAGIC)).toBe("image/png");
    expect(sniffAssetMime(JPEG_MAGIC)).toBe("image/jpeg");
    expect(sniffAssetMime(GIF_MAGIC)).toBe("image/gif");
    expect(sniffAssetMime(WEBP_MAGIC)).toBe("image/webp");
  });

  it("refuses a RIFF container that is not WebP", () => {
    // A .wav is RIFF too; only bytes 8-11 separate them, and image.go checks
    // exactly that.
    const wav = [...WEBP_MAGIC];
    wav[8] = 0x57;
    wav[9] = 0x41;
    wav[10] = 0x56;
    wav[11] = 0x45;
    expect(sniffAssetMime(wav)).toBeNull();
  });

  it("refuses HEIC, which iOS libraries are full of", () => {
    const heic = [
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ];
    expect(sniffAssetMime(heic)).toBeNull();
  });

  it("refuses a truncated PNG signature rather than guessing", () => {
    expect(sniffAssetMime(PNG_MAGIC.slice(0, 6))).toBeNull();
  });
});

describe("evaluateAssetUpload", () => {
  function candidate(bytes: readonly number[], overrides = {}) {
    return { base64: toBase64(bytes), fileName: "photo.HEIC", kind: "image", ...overrides };
  }

  it("passes a real PNG and reports the type the server will store", () => {
    const decision = evaluateAssetUpload(candidate(padded(PNG_MAGIC, 64)));
    expect(decision.ok).toBe(true);
    expect(decision.mime).toBe("image/png");
    expect(decision.bytes).toBe(64);
    expect(decision.message).toBe("");
  });

  it("refuses a video before any bytes move", () => {
    const decision = evaluateAssetUpload(
      candidate(padded(PNG_MAGIC, 64), { kind: "video" }),
    );
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("not_an_image");
    expect(decision.message).toContain("images only");
  });

  it("refuses an empty pick as no_data, matching errEmpty", () => {
    const decision = evaluateAssetUpload({ base64: "", kind: "image" });
    expect(decision.reason).toBe("no_data");
  });

  it("refuses an oversized image and names both sizes", () => {
    const decision = evaluateAssetUpload({
      // Skip building 10 MiB of bytes: the gate reads the base64 LENGTH.
      base64: "A".repeat(Math.ceil(((ASSET_MAX_BYTES + 1024) * 4) / 3)),
      kind: "image",
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("too_large");
    expect(decision.message).toContain("10 MB");
  });

  it("checks size BEFORE format, exactly as the server does", () => {
    // image.go:78 returns errTooBig before it ever looks at the signature, so
    // a 12 MB HEIC must be reported as too large, not as the wrong type.
    const decision = evaluateAssetUpload({
      base64: "A".repeat(Math.ceil(((ASSET_MAX_BYTES + 1024) * 4) / 3)),
      kind: "image",
    });
    expect(decision.reason).toBe("too_large");
  });

  it("refuses a format the decoder cannot read", () => {
    const decision = evaluateAssetUpload(candidate([0x00, 0x01, 0x02, 0x03]));
    expect(decision.reason).toBe("unsupported_type");
    expect(decision.message).toContain("PNG, JPEG, GIF and WebP");
  });

  it("treats an unstated media kind as an image rather than refusing it", () => {
    // `ImagePickerAsset.type` is documented as possibly null on Android.
    const decision = evaluateAssetUpload({
      base64: toBase64(padded(JPEG_MAGIC, 32)),
      kind: null,
    });
    expect(decision.ok).toBe(true);
  });
});

describe("assetStoredFilename — sanitizeAssetFilename, reproduced", () => {
  it("replaces the caller's extension with the decoder-confirmed one", () => {
    // handlers.go:568 always discards the supplied suffix, so a .png name
    // carrying JPEG bytes is stored as .jpg.
    expect(assetStoredFilename("logo.png", "image/jpeg")).toBe("logo.jpg");
    expect(assetStoredFilename("shot.HEIC", "image/jpeg")).toBe("shot.jpg");
  });

  it("keeps only the final path element", () => {
    expect(assetStoredFilename("a/b/c.png", "image/png")).toBe("c.png");
  });

  it("maps every other character to one underscore", () => {
    expect(assetStoredFilename("héllo wörld.png", "image/png")).toBe(
      "h_llo_w_rld.png",
    );
    expect(assetStoredFilename("🙂.png", "image/png")).toBe("_.png");
  });

  it("collapses dot runs and strips a leading dot", () => {
    expect(assetStoredFilename("..evil..name.png", "image/png")).toBe(
      "evil.name.png",
    );
  });

  it("falls back to `upload` when nothing survives", () => {
    expect(assetStoredFilename("", "image/png")).toBe("upload.png");
    expect(assetStoredFilename("...", "image/png")).toBe("upload.png");
    expect(assetStoredFilename(null, null)).toBe("upload");
  });

  it("caps the whole name at 128 including the extension", () => {
    const name = assetStoredFilename("x".repeat(400), "image/webp");
    expect(name).toHaveLength(128);
    expect(name.endsWith(".webp")).toBe(true);
  });
});

describe("assetSizeLabel", () => {
  it("uses the same 1024 base as MaxBytes", () => {
    expect(assetSizeLabel(ASSET_MAX_BYTES)).toBe("10 MB");
    expect(assetSizeLabel(512)).toBe("512 B");
    expect(assetSizeLabel(1536)).toBe("1.5 KB");
  });

  it("never invents a size it was not given", () => {
    expect(assetSizeLabel(Number.NaN)).toBe("unknown size");
    expect(assetSizeLabel(-1)).toBe("unknown size");
  });
});

/**
 * `decodeBase64Prefix` reads a 16-byte file signature out of a string that can
 * be 13.4 MB, and it used to begin by stripping whitespace from ALL of it —
 * scanning the entire payload to look at 22 characters of it, on the JS thread,
 * between the photo pick and the request. Measured at the 10 MiB server cap:
 * 3.467 ms to produce 16 bytes.
 *
 * Skipping whitespace inside the scan instead is only safe if it decodes
 * IDENTICALLY, so the pre-change implementation is kept here as the reference
 * and the two are compared over the awkward inputs: both alphabets, padding,
 * embedded newlines, whitespace adjacent to padding, garbage, empties, and a
 * budget of zero.
 */
function referenceDecodeBase64Prefix(
  value: string | null | undefined,
  maxBytes: number,
): number[] {
  const STD =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const URL_SAFE =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const sextet = (character: string): number => {
    const std = STD.indexOf(character);
    return std >= 0 ? std : URL_SAFE.indexOf(character);
  };
  const clean = (value ?? "").replace(/\s+/g, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of clean) {
    if (character === "=") break;
    const index = sextet(character);
    if (index < 0) return out;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      if (out.length >= maxBytes) return out;
    }
  }
  return out;
}

describe("decodeBase64Prefix skips whitespace without copying the payload", () => {
  it("decodes exactly what the pre-change implementation decoded", () => {
    const std = toBase64(padded(PNG_MAGIC, 64));
    const cases: [string | null | undefined, number][] = [
      [std, 16],
      [std, 1],
      [std, 0],
      [std, 4096],
      [`${std.slice(0, 8)}\n${std.slice(8, 24)}\r\n${std.slice(24)}`, 16],
      [`  \t${std}`, 12],
      [std.replaceAll("+", "-").replaceAll("/", "_"), 16],
      ["QUJDRA==", 8],
      ["QUJD= =", 8],
      ["QUJD  ", 8],
      ["=QUJD", 8],
      ["QUJD!!!!", 8],
      ["QU　JD", 8],
      ["QUJD\u{1f600}RA", 8],
      ["", 8],
      [null, 8],
      [undefined, 8],
    ];
    for (const [value, maxBytes] of cases) {
      expect(
        decodeBase64Prefix(value, maxBytes),
        `decode drifted from the reference for ${JSON.stringify(value)} @ ${maxBytes}`,
      ).toEqual(referenceDecodeBase64Prefix(value, maxBytes));
    }
  });

  it("never materialises a cleaned copy of the payload", () => {
    // A shape assertion, not a benchmark: the whole cost being removed here is
    // a whole-string transform, and `String.prototype.replace` is the only way
    // this module performs one. Zero calls IS the property.
    const spy = vi.spyOn(String.prototype, "replace");
    try {
      decodeBase64Prefix(toBase64(padded(PNG_MAGIC, 4096)), 16);
      expect(
        spy,
        "the prefix decoder scanned the whole payload again to read 16 bytes of it",
      ).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
