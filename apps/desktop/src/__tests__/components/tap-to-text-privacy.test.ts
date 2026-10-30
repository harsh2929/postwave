import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildSmsUri,
  escapeEmbedHtml,
  parseSmsDestination,
} from "../../components/sms/TapToTextBlockEditor";

describe("tap-to-text local QR and embed privacy", () => {
  it("builds a standards-shaped SMS URI and escapes copied embed labels", () => {
    expect(buildSmsUri("+1 (415) 555-0100", "JOIN NOW")).toBe(
      "sms:+14155550100?body=JOIN%20NOW",
    );
    expect(escapeEmbedHtml('<script>alert("x")</script> & join')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; join",
    );
  });

  it("rejects ambiguous or hostile destination identity instead of rewriting it", () => {
    expect(parseSmsDestination("12345")).toBe("12345");
    expect(parseSmsDestination("+1 (415) 555-0100")).toBe("+14155550100");
    expect(parseSmsDestination("14155550100")).toBeNull();
    expect(parseSmsDestination("+1CALL5550100")).toBeNull();
    expect(parseSmsDestination("+1\u202e4155550100")).toBeNull();
    expect(parseSmsDestination("123\n45")).toBeNull();
    expect(buildSmsUri("+1CALL5550100", "JOIN")).toBe("");
  });

  it("never throws or emits output for invalid Unicode controls and surrogates", () => {
    expect(() => buildSmsUri("12345", "bad\ud800body")).not.toThrow();
    expect(buildSmsUri("12345", "bad\ud800body")).toBe("");
    expect(buildSmsUri("12345", "JOIN\u202eEVIL")).toBe("");
    expect(buildSmsUri("12345", "JOIN\nNOW")).toBe("");
  });

  it("keeps phone/message QR generation on-device and out of the CSP", () => {
    const component = readFileSync(
      new URL("../../components/sms/TapToTextBlockEditor.tsx", import.meta.url),
      "utf8",
    );
    const tauriConfig = readFileSync(
      new URL("../../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    );
    expect(component).toContain("QRCode.toDataURL(uri");
    expect(component).not.toContain("qrserver");
    expect(component).toContain("does not configure a messaging provider");
    expect(component).toContain("record or prove consent");
    expect(component).not.toContain("they just press send");
    expect(component).not.toContain("match a configured opt-in keyword");
    expect(tauriConfig).not.toContain("qrserver");
  });
});
