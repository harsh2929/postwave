// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";

import { voiceTools } from "../../src/tools/voice.js";

function makeClient() {
  const voiceProfile = {
    get: vi.fn().mockResolvedValue({ id: "vp_001", tonality: {} }),
    addSource: vi.fn().mockResolvedValue({ source_id: "src_001" }),
    build: vi.fn().mockResolvedValue({ id: "vp_001", built_at: "2026-01-01T00:00:00Z" }),
  };
  const sequences = {
    generate: vi.fn().mockResolvedValue({ id: "seq_001", emails: [] }),
    regenerate: vi.fn().mockResolvedValue({ id: "seq_001", position: 1 }),
  };
  return { client: { voiceProfile, sequences }, voiceProfile, sequences };
}

describe("voiceTools", () => {
  it("exposes exactly 5 tools", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = voiceTools(client as any);
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "sequence_generate",
      "sequence_regenerate_email",
      "voice_profile_build",
      "voice_profile_get",
      "voice_source_add",
    ]);
  });

  it("each tool has a schema and a non-trivial description", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of voiceTools(client as any)) {
      expect(typeof t.schema.safeParse).toBe("function");
      expect(t.description.length).toBeGreaterThan(15);
    }
  });

  it("voice_profile_get calls SDK", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = voiceTools(c.client as any).find((x) => x.name === "voice_profile_get")!;
    await t.handler({});
    expect(c.voiceProfile.get).toHaveBeenCalledTimes(1);
  });

  it("voice_source_add validates URL via SSRF guard for http sources", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = voiceTools(c.client as any).find((x) => x.name === "voice_source_add")!;
    await expect(
      t.handler({ type: "url", params: { url: "http://127.0.0.1/feed" } }),
    ).rejects.toThrow();
    expect(c.voiceProfile.addSource).not.toHaveBeenCalled();
  });

  it("voice_source_add requires type-specific params", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = voiceTools(c.client as any).find((x) => x.name === "voice_source_add")!;
    expect(t.schema.safeParse({ type: "url", params: {} }).success).toBe(false);
    expect(t.schema.safeParse({ type: "rss", params: {} }).success).toBe(false);
    expect(t.schema.safeParse({ type: "twitter", params: {} }).success).toBe(false);
    expect(t.schema.safeParse({ type: "paste", params: {} }).success).toBe(false);
    expect(t.schema.safeParse({ type: "transcript", params: {} }).success).toBe(false);
  });

  it("voice_source_add accepts a public URL and forwards", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = voiceTools(c.client as any).find((x) => x.name === "voice_source_add")!;
    await t.handler({ type: "rss", params: { url: "https://example.invalid/feed.xml" } });
    expect(c.voiceProfile.addSource).toHaveBeenCalledTimes(1);
  });

  it("sequence_generate forwards template_id with default empty maps", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = voiceTools(c.client as any).find((x) => x.name === "sequence_generate")!;
    await t.handler({ template_id: "tpl_welcome_3" });
    expect(c.sequences.generate).toHaveBeenCalledWith({
      template_id: "tpl_welcome_3",
      variables: {},
      style_controls: {},
    });
  });

  it("sequence_regenerate_email forwards id, position, hint", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = voiceTools(c.client as any).find((x) => x.name === "sequence_regenerate_email")!;
    await t.handler({ sequence_id: "seq_001", position: 2, hint: "shorter" });
    expect(c.sequences.regenerate).toHaveBeenCalledWith("seq_001", 2, { hint: "shorter" });
  });

  it("sequence_regenerate_email rejects negative position", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = voiceTools(c.client as any).find((x) => x.name === "sequence_regenerate_email")!;
    expect(t.schema.safeParse({ sequence_id: "seq_001", position: -1 }).success).toBe(false);
    expect(t.schema.safeParse({ sequence_id: "seq_001", position: 0 }).success).toBe(false);
    expect(t.schema.safeParse({ sequence_id: "   ", position: 1 }).success).toBe(false);
  });
});
