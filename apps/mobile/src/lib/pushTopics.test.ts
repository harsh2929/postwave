import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  },
}));

const {
  MAX_PUSH_TOPICS,
  defaultPushSelection,
  groupedPushTopics,
  isRequiredPushEvent,
  pushEligibleEvents,
  readPushTopicSelection,
  resolveEnabledPushEvents,
  sanitizePushSelection,
  togglePushTopic,
  writePushTopicSelection,
} = await import("./pushTopics");

beforeEach(() => {
  store.clear();
});

describe("pushEligibleEvents", () => {
  it("comes from the shared manifest, not a mobile-local list", () => {
    const events = pushEligibleEvents();
    expect(events).toContain("approval.requested");
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(MAX_PUSH_TOPICS);
  });

  it("is stable and de-duplicated", () => {
    const events = pushEligibleEvents();
    expect(new Set(events).size).toBe(events.length);
    expect(events).toEqual([...events].sort());
  });
});

describe("defaultPushSelection", () => {
  it("keeps the high-signal approvals ping on by default", () => {
    expect(defaultPushSelection()).toContain("approval.requested");
  });

  it("keeps account-security alerts on for compatible clients", () => {
    expect(defaultPushSelection()).toContain("auth.new_device_sign_in");
    expect(isRequiredPushEvent("auth.new_device_sign_in")).toBe(true);
  });

  it("is a subset of the eligible set and within the server cap", () => {
    const eligible = new Set(pushEligibleEvents());
    const defaults = defaultPushSelection();
    expect(defaults.every((e) => eligible.has(e))).toBe(true);
    expect(defaults.length).toBeLessThanOrEqual(MAX_PUSH_TOPICS);
  });
});

describe("groupedPushTopics", () => {
  it("groups every eligible event exactly once", () => {
    const groups = groupedPushTopics();
    const flattened = groups.flatMap((g) => g.events.map((e) => e.event));
    expect(flattened.sort()).toEqual(pushEligibleEvents());
  });

  it("puts approval.requested in the approvals category", () => {
    const approvals = groupedPushTopics().find(
      (g) => g.category === "approvals",
    );
    expect(approvals?.events.map((e) => e.event)).toContain(
      "approval.requested",
    );
  });
});

describe("sanitizePushSelection", () => {
  it("returns null for a non-array, meaning 'no stored preference'", () => {
    expect(sanitizePushSelection(null)).toBeNull();
    expect(sanitizePushSelection("approval.requested")).toBeNull();
  });

  it("distinguishes an explicitly empty selection from no preference", () => {
    expect(sanitizePushSelection([])).toEqual([]);
  });

  it("drops unknown events an older build may have stored", () => {
    expect(
      sanitizePushSelection(["approval.requested", "legacy.event", 42]),
    ).toEqual(["approval.requested"]);
  });

  it("de-duplicates and enforces the server's item cap", () => {
    const many = [...pushEligibleEvents(), ...pushEligibleEvents()];
    const clean = sanitizePushSelection(many);
    expect(clean).toHaveLength(pushEligibleEvents().length);
    expect(clean?.length).toBeLessThanOrEqual(MAX_PUSH_TOPICS);
  });
});

describe("togglePushTopic", () => {
  it("adds and removes without mutating the input", () => {
    const base = ["approval.requested"];
    const added = togglePushTopic(base, "campaign.sent", true);
    expect(added).toContain("campaign.sent");
    expect(base).toEqual(["approval.requested"]);
    expect(togglePushTopic(added, "campaign.sent", false)).toEqual([
      "auth.new_device_sign_in",
      ...base,
    ]);
  });

  it("does not allow the mandatory security event to be switched off", () => {
    expect(
      togglePushTopic(["auth.new_device_sign_in"], "auth.new_device_sign_in", false),
    ).toEqual(["auth.new_device_sign_in"]);
  });

  it("is idempotent when enabling something already on", () => {
    expect(togglePushTopic(["campaign.sent"], "campaign.sent", true)).toEqual([
      "auth.new_device_sign_in",
      "campaign.sent",
    ]);
  });
});

describe("storage", () => {
  it("falls back to the defaults with nothing stored", async () => {
    expect(await readPushTopicSelection()).toEqual(defaultPushSelection());
  });

  it("upgrades an explicit selection with the mandatory security event", async () => {
    await writePushTopicSelection(["approval.requested"]);
    expect(await readPushTopicSelection()).toEqual([
      "auth.new_device_sign_in",
      "approval.requested",
    ]);
  });

  it("keeps security alerts when every optional topic is off", async () => {
    await writePushTopicSelection([]);
    expect(await readPushTopicSelection()).toEqual([
      "auth.new_device_sign_in",
    ]);
  });

  it("recovers from a corrupted stored value", async () => {
    store.set("postwave.push_topics.v1", "{not json");
    expect(await readPushTopicSelection()).toEqual(defaultPushSelection());
  });

  it("feeds the device registration array", async () => {
    await writePushTopicSelection(["approval.requested"]);
    expect(await resolveEnabledPushEvents()).toEqual([
      "auth.new_device_sign_in",
      "approval.requested",
    ]);
  });
});
