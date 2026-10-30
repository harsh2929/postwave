import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GMAIL_CLIP_THRESHOLD_BYTES,
  classifyClipVerdict,
  formatBytes,
  measureEmailByteSize,
  measureEmbeddedImages,
  utf8ByteLength,
  verdictMessage,
} from "../../lib/email-byte-size";

describe("utf8ByteLength", () => {
  it("counts ASCII as 1 byte/char", () => {
    expect(utf8ByteLength("hello")).toBe(5);
  });
  it("counts an empty string as 0", () => {
    expect(utf8ByteLength("")).toBe(0);
  });
  it("counts multi-byte UTF-8 (emoji = 4)", () => {
    // 🚀 = U+1F680 = 4-byte UTF-8 sequence.
    expect(utf8ByteLength("🚀")).toBe(4);
  });
  it("counts accented Latin (é = 2 bytes)", () => {
    expect(utf8ByteLength("é")).toBe(2);
  });

  describe("manual fallback (TextEncoder absent)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("matches TextEncoder for mixed content", () => {
      const s = "héllo 🚀 world";
      const expected = utf8ByteLength(s); // TextEncoder path
      vi.stubGlobal("TextEncoder", undefined);
      expect(utf8ByteLength(s)).toBe(expected);
    });

    it("lone high surrogate counts 3 bytes and does NOT swallow the next char", () => {
      vi.stubGlobal("TextEncoder", undefined);
      // \uD800 unpaired → U+FFFD (3 bytes); the following "a" is 1 byte.
      expect(utf8ByteLength("\uD800a")).toBe(4);
      // Trailing lone high surrogate → 3 bytes.
      expect(utf8ByteLength("a\uD800")).toBe(4);
      // Valid pair is still 4 bytes.
      expect(utf8ByteLength("🚀")).toBe(4);
    });
  });
});

describe("measureEmbeddedImages", () => {
  it("returns zero for plain HTML", () => {
    expect(measureEmbeddedImages("<p>hello</p>")).toEqual({
      count: 0,
      bytes: 0,
    });
  });
  it("detects a base64 data URI in img src", () => {
    const html = '<img src="data:image/png;base64,iVBORw0KGgoAAAANS">';
    const m = measureEmbeddedImages(html);
    expect(m.count).toBe(1);
    expect(m.bytes).toBeGreaterThan(0);
  });
  it("detects multiple embedded images", () => {
    const html =
      '<img src="data:image/png;base64,AAA"><img src=\'data:image/jpeg;base64,BBB\'>';
    expect(measureEmbeddedImages(html).count).toBe(2);
  });
  it("ignores non-image data URIs", () => {
    const html = '<a href="data:application/pdf;base64,XX">x</a>';
    expect(measureEmbeddedImages(html).count).toBe(0);
  });
});

describe("classifyClipVerdict", () => {
  it("verdict 'ok' for small payloads", () => {
    expect(classifyClipVerdict(1024)).toBe("ok");
  });
  it("verdict 'warn' at ≥ 80% of threshold", () => {
    const at80 = Math.floor(GMAIL_CLIP_THRESHOLD_BYTES * 0.8) + 1;
    expect(classifyClipVerdict(at80)).toBe("warn");
  });
  it("verdict 'critical' at ≥ 100% of threshold", () => {
    expect(classifyClipVerdict(GMAIL_CLIP_THRESHOLD_BYTES)).toBe("critical");
    expect(classifyClipVerdict(GMAIL_CLIP_THRESHOLD_BYTES + 100)).toBe(
      "critical",
    );
  });
  it("just-under boundary stays in lower bucket", () => {
    expect(classifyClipVerdict(GMAIL_CLIP_THRESHOLD_BYTES - 1)).toBe("warn");
    const justUnder80 = Math.floor(GMAIL_CLIP_THRESHOLD_BYTES * 0.8) - 1;
    expect(classifyClipVerdict(justUnder80)).toBe("ok");
  });
});

describe("measureEmailByteSize", () => {
  it("returns ok for small HTML", () => {
    const m = measureEmailByteSize("<p>hi</p>");
    expect(m.verdict).toBe("ok");
    expect(m.bytes).toBe(9);
    expect(m.remainingBytes).toBe(GMAIL_CLIP_THRESHOLD_BYTES - 9);
    expect(m.embeddedImageCount).toBe(0);
  });
  it("returns warn near threshold", () => {
    // Inflate the body to ~85% of threshold.
    const filler = "x".repeat(Math.floor(GMAIL_CLIP_THRESHOLD_BYTES * 0.85));
    const m = measureEmailByteSize(filler);
    expect(m.verdict).toBe("warn");
    expect(m.ratio).toBeGreaterThan(0.8);
    expect(m.ratio).toBeLessThan(1);
  });
  it("returns critical when over threshold and reports negative remaining", () => {
    const filler = "x".repeat(GMAIL_CLIP_THRESHOLD_BYTES + 500);
    const m = measureEmailByteSize(filler);
    expect(m.verdict).toBe("critical");
    expect(m.remainingBytes).toBeLessThan(0);
  });
  it("counts embedded images into the verdict", () => {
    const tinyDataUri =
      "data:image/png;base64," + "A".repeat(GMAIL_CLIP_THRESHOLD_BYTES);
    const m = measureEmailByteSize(`<img src="${tinyDataUri}">`);
    expect(m.verdict).toBe("critical");
    expect(m.embeddedImageCount).toBe(1);
    expect(m.embeddedImageBytes).toBeGreaterThan(GMAIL_CLIP_THRESHOLD_BYTES);
  });
  it("handles empty / null-ish input safely", () => {
    const m = measureEmailByteSize("");
    expect(m.bytes).toBe(0);
    expect(m.verdict).toBe("ok");
    expect(m.embeddedImageCount).toBe(0);
  });
});

describe("formatBytes", () => {
  it("formats sub-1KB as bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });
  it("formats KB with one decimal under 100KB", () => {
    expect(formatBytes(50 * 1024)).toBe("50.0 KB");
  });
  it("formats large KB without decimals", () => {
    expect(formatBytes(200 * 1024)).toBe("200 KB");
  });
  it("formats MB", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
  it("negative is em-dash", () => {
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("verdictMessage", () => {
  it("ok message mentions 'well under'", () => {
    const m = measureEmailByteSize("<p>hi</p>");
    expect(verdictMessage(m)).toMatch(/well under/i);
  });
  it("warn message asks the operator to trim", () => {
    const filler = "x".repeat(Math.floor(GMAIL_CLIP_THRESHOLD_BYTES * 0.85));
    expect(verdictMessage(measureEmailByteSize(filler))).toMatch(/Trim/);
  });
  it("critical message highlights how far over the cut", () => {
    const filler = "x".repeat(GMAIL_CLIP_THRESHOLD_BYTES + 2048);
    const msg = verdictMessage(measureEmailByteSize(filler));
    expect(msg).toMatch(/over Gmail/i);
    expect(msg).toMatch(/clipping limit/i);
  });
  it("critical with embedded images suggests external hosting", () => {
    const dataUri =
      "data:image/png;base64," + "A".repeat(GMAIL_CLIP_THRESHOLD_BYTES + 2048);
    const msg = verdictMessage(measureEmailByteSize(`<img src="${dataUri}">`));
    expect(msg).toMatch(/host externally/i);
  });
});
