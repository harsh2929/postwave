import { describe, expect, it } from "vitest";

import {
  OUTBOUND_SELECTION_MAX,
  bulkWebhookAvailability,
  bulkWebhookBusyLabel,
  bulkWebhookConfirmCopy,
  bulkWebhookOutcomeMessage,
  partitionForVerb,
  pruneWebhookSelection,
  selectedWebhooks,
  toggleWebhookSelection,
  verbBlockedReason,
  webhookSelectionLabel,
  webhookSelectionTitle,
} from "./outboundWebhookSelection";

function hook(id: string, active = true, description?: string) {
  return {
    id,
    url: `https://receiver.example.com/hooks/${id}`,
    active,
    ...(description !== undefined ? { description } : {}),
  };
}

const ALL_ON = { hasAdminRole: true, online: true, gated: false };

describe("toggleWebhookSelection", () => {
  it("adds in tap order and removes without reordering the rest", () => {
    expect(toggleWebhookSelection([], "a")).toEqual(["a"]);
    expect(toggleWebhookSelection(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleWebhookSelection(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("ignores an empty id rather than selecting nothing", () => {
    expect(toggleWebhookSelection(["a"], "")).toEqual(["a"]);
  });
});

describe("pruneWebhookSelection", () => {
  it("drops ids that left the loaded list after a refetch", () => {
    expect(pruneWebhookSelection(["a", "b"], ["b", "c"])).toEqual(["b"]);
  });
});

describe("selectedWebhooks", () => {
  it("returns rows in LIST order, not selection order", () => {
    const rows = [hook("a"), hook("b"), hook("c")];
    expect(selectedWebhooks(rows, ["c", "a"]).map((r) => r.id)).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("webhookSelectionLabel", () => {
  it("prefers the description and falls back to a middle-truncated url", () => {
    expect(webhookSelectionLabel(hook("a", true, "  Data warehouse "))).toBe(
      "Data warehouse",
    );
    const label = webhookSelectionLabel(
      hook("a-very-long-identifier-that-keeps-going-and-going-and-going"),
    );
    // The tail is what distinguishes two receivers; it must survive.
    expect(label.endsWith("going")).toBe(true);
    expect(label).toContain("…");
  });
});

describe("partitionForVerb", () => {
  const rows = [hook("on", true), hook("off", false)];

  it("pause acts only on active rows and states the rest as skipped", () => {
    const p = partitionForVerb(rows, "pause");
    expect(p.applicable.map((r) => r.id)).toEqual(["on"]);
    expect(p.skipped.map((r) => r.id)).toEqual(["off"]);
  });

  it("resume acts only on inactive rows", () => {
    const p = partitionForVerb(rows, "resume");
    expect(p.applicable.map((r) => r.id)).toEqual(["off"]);
    expect(p.skipped.map((r) => r.id)).toEqual(["on"]);
  });

  it("delete acts on every row", () => {
    const p = partitionForVerb(rows, "delete");
    expect(p.applicable).toHaveLength(2);
    expect(p.skipped).toHaveLength(0);
  });
});

describe("bulkWebhookAvailability", () => {
  it("names the role before the connection — reconnecting won't fix a role", () => {
    const a = bulkWebhookAvailability({
      count: 2,
      hasAdminRole: false,
      online: false,
      gated: true,
    });
    expect(a.enabled).toBe(false);
    expect(a.reason).toMatch(/owner or admin role/u);
  });

  it("names a stale session before an offline device", () => {
    const a = bulkWebhookAvailability({
      count: 2,
      hasAdminRole: true,
      online: false,
      gated: true,
    });
    expect(a.reason).toMatch(/Reconnect this session/u);
  });

  it("refuses offline and says bulk actions are not queued", () => {
    const a = bulkWebhookAvailability({
      count: 2,
      hasAdminRole: true,
      online: false,
      gated: false,
    });
    expect(a.reason).toMatch(/aren't queued/u);
  });

  it("asks for a selection when nothing is picked", () => {
    expect(bulkWebhookAvailability({ count: 0, ...ALL_ON }).reason).toBe(
      "Select at least one webhook.",
    );
  });

  it("caps the selection at the phone ceiling", () => {
    const a = bulkWebhookAvailability({
      count: OUTBOUND_SELECTION_MAX + 1,
      ...ALL_ON,
    });
    expect(a.enabled).toBe(false);
    expect(a.reason).toContain(String(OUTBOUND_SELECTION_MAX));
    expect(
      bulkWebhookAvailability({ count: OUTBOUND_SELECTION_MAX, ...ALL_ON })
        .enabled,
    ).toBe(true);
  });

  it("is enabled when admin, online, fresh, and something is selected", () => {
    expect(bulkWebhookAvailability({ count: 1, ...ALL_ON })).toEqual({
      enabled: true,
    });
  });
});

describe("verbBlockedReason", () => {
  const enabled = { enabled: true } as const;

  it("carries the shared availability reason first", () => {
    expect(
      verbBlockedReason("pause", [hook("a")], {
        enabled: false,
        reason: "nope",
      }),
    ).toBe("nope");
  });

  it("blocks pause when every selected row is already paused", () => {
    expect(verbBlockedReason("pause", [hook("a", false)], enabled)).toBe(
      "Every selected webhook is already paused.",
    );
    expect(verbBlockedReason("pause", [hook("a", true)], enabled)).toBeNull();
  });

  it("blocks resume when every selected row is already active", () => {
    expect(verbBlockedReason("resume", [hook("a", true)], enabled)).toBe(
      "Every selected webhook is already active.",
    );
    expect(verbBlockedReason("resume", [hook("a", false)], enabled)).toBeNull();
  });

  it("never blocks delete on state — it applies to every row", () => {
    expect(verbBlockedReason("delete", [hook("a", false)], enabled)).toBeNull();
  });
});

describe("bulkWebhookConfirmCopy", () => {
  it("does not confirm resume — it is the recovery verb", () => {
    expect(
      bulkWebhookConfirmCopy("resume", partitionForVerb([hook("a", false)], "resume")),
    ).toBeNull();
  });

  it("states the pause split BEFORE the tap, not as a shortfall afterwards", () => {
    const copy = bulkWebhookConfirmCopy(
      "pause",
      partitionForVerb([hook("a"), hook("b"), hook("c", false)], "pause"),
    );
    expect(copy?.title).toBe("Pause 2 webhooks?");
    expect(copy?.consequence).toBe("1 webhook already paused will be left alone.");
    expect(copy?.destructive).toBe(false);
    expect(copy?.confirmLabel).toBe("Pause");
  });

  it("omits the consequence when nothing is skipped", () => {
    const copy = bulkWebhookConfirmCopy("pause", partitionForVerb([hook("a")], "pause"));
    expect(copy?.consequence).toBeUndefined();
  });

  it("names the rows delete will remove, caps the list, and says it cannot be undone", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g"].map((id) =>
      hook(id, true, `Sink ${id}`),
    );
    const copy = bulkWebhookConfirmCopy("delete", partitionForVerb(rows, "delete"));
    expect(copy?.title).toBe("Delete 7 webhooks?");
    expect(copy?.message).toBe("Sink a, Sink b, Sink c, Sink d, Sink e and 2 more");
    expect(copy?.destructive).toBe(true);
    expect(copy?.consequence).toMatch(/can't be undone/u);
    // The server's own retention promise is in the sentence, not a guess.
    expect(copy?.consequence).toMatch(/Delivery history is kept until retention purges it/u);
  });
});

describe("bulkWebhookOutcomeMessage", () => {
  it("reports a clean run with the count, and the skipped rows separately", () => {
    expect(
      bulkWebhookOutcomeMessage("pause", {
        succeeded: ["A", "B"],
        failed: [],
        skipped: ["C"],
      }),
    ).toBe("Paused 2 webhooks. 1 webhook already paused was skipped.");
  });

  it("never appends a skipped tail to delete — delete skips nothing", () => {
    expect(
      bulkWebhookOutcomeMessage("delete", {
        succeeded: ["A"],
        failed: [],
        skipped: [],
      }),
    ).toBe("Deleted 1 webhook.");
  });

  it("quotes the server's reason when the single row failed", () => {
    expect(
      bulkWebhookOutcomeMessage("resume", {
        succeeded: [],
        failed: [
          {
            id: "a",
            label: "Data warehouse",
            reason: "replace the destination URL before re-enabling this webhook",
          },
        ],
        skipped: [],
      }),
    ).toBe(
      'Couldn\'t resume "Data warehouse" — replace the destination URL before re-enabling this webhook',
    );
  });

  it("names up to three failures on a partial run and says they stay selected", () => {
    const failed = ["w", "x", "y", "z"].map((id) => ({
      id,
      label: id.toUpperCase(),
      reason: "the server refused it",
    }));
    expect(
      bulkWebhookOutcomeMessage("delete", { succeeded: ["A", "B"], failed, skipped: [] }),
    ).toBe(
      'Deleted 2 of 6. "W", "X", "Y" and 1 more were left unchanged and stay selected for retry — the server refused it',
    );
  });

  it("says nothing changed when every row failed", () => {
    expect(
      bulkWebhookOutcomeMessage("pause", {
        succeeded: [],
        failed: [
          { id: "a", label: "A", reason: "boom" },
          { id: "b", label: "B", reason: "boom" },
        ],
        skipped: [],
      }),
    ).toBe("Couldn't pause any of the 2 selected webhooks — boom");
  });
});

describe("copy helpers", () => {
  it("titles the bar with the count and a prompt at zero", () => {
    expect(webhookSelectionTitle(0)).toBe("Select webhooks");
    expect(webhookSelectionTitle(3)).toBe("3 selected");
  });

  it("counts the loop off with the verb's progressive form", () => {
    expect(bulkWebhookBusyLabel("resume", 2, 5)).toBe("Resuming 2 of 5…");
    expect(bulkWebhookBusyLabel("delete", 0, 1)).toBe("Deleting 0 of 1…");
  });
});
