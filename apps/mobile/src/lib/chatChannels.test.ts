import { describe, expect, it } from "vitest";

import {
  foldChatChannelResults,
  parseChatChannels,
  type ChatChannel,
} from "../lib/chatChannels";

describe("parseChatChannels", () => {
  it("reads both envelope shapes", () => {
    const rows = [{ id: "c1", name: "#alerts", active: true }];
    expect(parseChatChannels("slack", rows)).toHaveLength(1);
    expect(parseChatChannels("slack", { items: rows })).toHaveLength(1);
    expect(parseChatChannels("slack", { integrations: rows })).toHaveLength(1);
    expect(parseChatChannels("slack", null)).toEqual([]);
  });

  it("treats an ABSENT active flag as active", () => {
    // These rows are created enabled. Rendering a working channel as disabled
    // would have someone "fix" a channel that is fine — and the fix is a PATCH
    // that silences it.
    expect(parseChatChannels("slack", [{ id: "c1" }])[0]?.active).toBe(true);
  });

  it("treats an explicit false as inactive, and a non-boolean as inactive", () => {
    expect(parseChatChannels("slack", [{ id: "c1", active: false }])[0]?.active).toBe(
      false,
    );
    // A string "true" is not a boolean; refusing to coerce keeps the switch
    // honest rather than optimistic.
    expect(
      parseChatChannels("slack", [{ id: "c1", active: "true" }])[0]?.active,
    ).toBe(false);
  });

  it("drops rows with no id, whose test and toggle would both throw", () => {
    expect(parseChatChannels("discord", [{ name: "ghost" }])).toEqual([]);
  });

  it("falls back through the channel fields before using the provider name", () => {
    expect(parseChatChannels("teams", [{ id: "c1", channel: "#ops" }])[0]?.name).toBe(
      "#ops",
    );
    expect(parseChatChannels("teams", [{ id: "c1" }])[0]?.name).toBe("Teams");
  });

  it("stamps the provider onto every row, since the list is flattened", () => {
    expect(parseChatChannels("discord", [{ id: "c1" }])[0]?.provider).toBe(
      "discord",
    );
  });
});

describe("foldChatChannelResults — partial failure vs total failure", () => {
  const row = (id: string): ChatChannel => ({
    id,
    provider: "slack",
    name: `#${id}`,
    active: true,
  });

  it("absorbs a PARTIAL failure so one dead webhook cannot hide the others", () => {
    const folded = foldChatChannelResults([
      { status: "fulfilled", value: [row("a")] },
      { status: "rejected", reason: new Error("discord 500") },
      { status: "fulfilled", value: [row("b")] },
    ]);
    expect(folded.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("THROWS when every provider failed, instead of returning an empty list", () => {
    // The whole finding: flattening this to [] produced a SUCCESSFUL query
    // holding no rows, so the panel — which renders only when it has rows —
    // vanished from the screen and the operator read the outage as "this
    // workspace has no alert channels".
    expect(() =>
      foldChatChannelResults([
        { status: "rejected", reason: new Error("slack 500") },
        { status: "rejected", reason: new Error("discord 500") },
        { status: "rejected", reason: new Error("teams 500") },
      ]),
    ).toThrow("slack 500");
  });

  it("carries a non-Error rejection through as an Error rather than swallowing it", () => {
    expect(() =>
      foldChatChannelResults([{ status: "rejected", reason: "gateway down" }]),
    ).toThrow("gateway down");
  });

  it("returns an empty list for a genuinely empty SUCCESSFUL read", () => {
    // No providers refused, so there really are no channels.
    expect(
      foldChatChannelResults([
        { status: "fulfilled", value: [] },
        { status: "fulfilled", value: [] },
        { status: "fulfilled", value: [] },
      ]),
    ).toEqual([]);
  });
});
