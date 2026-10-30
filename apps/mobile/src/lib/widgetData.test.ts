import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  data: new Map<string, string | number>(),
  reloadWidget: vi.fn(),
  failSetKey: null as string | null,
  failRemoveKey: null as string | null,
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

vi.mock("@bacons/apple-targets", () => ({
  ExtensionStorage: class {
    set(key: string, value: string | number) {
      if (native.failSetKey === key) {
        native.failSetKey = null;
        throw new Error("set failed");
      }
      native.data.set(key, value);
    }
    get(key: string) {
      return native.data.get(key) ?? null;
    }
    remove(key: string) {
      if (native.failRemoveKey === key) {
        native.failRemoveKey = null;
        throw new Error("remove failed");
      }
      native.data.delete(key);
    }
    static reloadWidget = native.reloadWidget;
  },
}));

afterEach(() => {
  vi.useRealTimers();
});

// eslint-disable-next-line import/first
import {
  WIDGET_SNAPSHOT_FRESH_MS,
  WIDGET_SNAPSHOT_TTL_MS,
  buildWidgetPayload,
  clearWidgetSnapshot,
  clearWidgetSnapshotStrict,
  getWidgetMetricsEnabled,
  setWidgetMetricsEnabled,
  writeWidgetSnapshot,
} from "./widgetData";

const healthyInput = {
  subscribers: 10,
  openRate: 40,
  sent30d: 2,
  pending: 1,
  workspace: "Acme",
};

beforeEach(() => {
  native.data.clear();
  native.reloadWidget.mockClear();
  native.failSetKey = null;
  native.failRemoveKey = null;
  vi.useRealTimers();
});

describe("buildWidgetPayload", () => {
  it("rounds and passes through healthy numbers", () => {
    expect(
      buildWidgetPayload({
        subscribers: 12_400.4,
        openRate: 42.47,
        sent30d: 18,
        pending: 2,
        workspace: "Acme",
      }),
    ).toEqual({
      subs: 12_400,
      subsKnown: true,
      openRate: 42,
      openRateKnown: true,
      sent30d: 18,
      sent30dKnown: true,
      pending: 2,
      workspace: "Acme",
    });
  });

  it("coerces invalid numbers and bounds native integers", () => {
    expect(
      buildWidgetPayload({
        subscribers: Number.MAX_VALUE,
        openRate: undefined,
        sent30d: -5,
        pending: Number.NaN,
        workspace: null,
      }),
    ).toEqual({
      subs: 2_147_483_647,
      subsKnown: true,
      openRate: 0,
      // Absent, and marked as such rather than published as a zero.
      openRateKnown: false,
      sent30d: 0,
      // A negative count cannot have been measured by anything.
      sent30dKnown: false,
      pending: 0,
      workspace: "Moosewave",
    });
  });

  /**
   * DASHBOARD#72 — absence is not zero.
   *
   * `ExtensionStorage` stores an Int and an Int cannot say "not measured", so
   * every unmeasured figure used to arrive at the widget as a 0 and the reader
   * had to guess. It guessed differently for the two shapes and both guesses
   * were wrong: a missing subscriber count rendered as a confident "0", and a
   * genuine 0% open rate hid behind the same em-dash as a missing field.
   */
  describe("absence markers", () => {
    it("marks a genuine zero as MEASURED", () => {
      const payload = buildWidgetPayload({
        subscribers: 0,
        openRate: 0,
        sent30d: 0,
        pending: 0,
        workspace: "Acme",
      });
      expect(payload).toMatchObject({
        subs: 0,
        subsKnown: true,
        openRate: 0,
        openRateKnown: true,
        sent30d: 0,
        sent30dKnown: true,
      });
    });

    it("marks every absent figure as unmeasured", () => {
      expect(
        buildWidgetPayload({
          subscribers: null,
          openRate: undefined,
          sent30d: null,
          pending: 3,
          workspace: "Acme",
        }),
      ).toMatchObject({
        subsKnown: false,
        openRateKnown: false,
        sent30dKnown: false,
      });
    });

    it("publishes the markers in the same transaction as the values", () => {
      expect(setWidgetMetricsEnabled(true)).toBe(true);
      expect(
        writeWidgetSnapshot({
          subscribers: 10,
          openRate: null,
          sent30d: 4,
          pending: 1,
          workspace: "Acme",
        }),
      ).toBe(true);
      expect(native.data.get("pw_widget_subs_known")).toBe(1);
      expect(native.data.get("pw_widget_open_rate_known")).toBe(0);
      expect(native.data.get("pw_widget_sent30d_known")).toBe(1);
      // The placeholder beside an unmeasured marker is still bounded.
      expect(native.data.get("pw_widget_open_rate")).toBe(0);
      // And the transaction still closed.
      expect(native.data.get("pw_widget_ready")).toBe(1);
    });

    it("purges the markers with the disclosure they describe", () => {
      expect(setWidgetMetricsEnabled(true)).toBe(true);
      expect(writeWidgetSnapshot(healthyInput)).toBe(true);
      expect(native.data.has("pw_widget_open_rate_known")).toBe(true);
      expect(clearWidgetSnapshot()).toBe(true);
      for (const key of [
        "pw_widget_subs_known",
        "pw_widget_open_rate_known",
        "pw_widget_sent30d_known",
      ]) {
        expect(native.data.has(key), `${key} survived the purge`).toBe(false);
      }
    });
  });

  it("clamps percentages and trims a workspace name", () => {
    const payload = buildWidgetPayload({
      subscribers: 1,
      openRate: 250,
      sent30d: 0,
      pending: 0,
      workspace: "  Beta\n\u0000 Co  ",
    });
    expect(payload.openRate).toBe(100);
    expect(payload.workspace).toBe("Beta Co");
  });

  it("bounds workspace names by UTF-8 bytes without splitting a character", () => {
    const workspace = buildWidgetPayload({
      ...healthyInput,
      workspace: "🛡️".repeat(100),
    }).workspace;

    expect(new TextEncoder().encode(workspace).byteLength).toBeLessThanOrEqual(
      128,
    );
    expect(workspace.endsWith("\uFFFD")).toBe(false);
  });
});

describe("widget privacy and storage", () => {
  it("is off by default and never writes metrics without explicit opt-in", () => {
    native.data.set("pw_widget_workspace", "Legacy account");
    native.data.set("pw_widget_ready", 1);
    expect(getWidgetMetricsEnabled()).toBe(false);
    expect(writeWidgetSnapshot(healthyInput)).toBe(false);
    expect([...native.data.keys()]).toEqual([]);
  });

  it("clears any old snapshot before committing opt-in", () => {
    native.data.set("pw_widget_workspace", "Previous account");
    native.data.set("pw_widget_ready", 1);

    expect(setWidgetMetricsEnabled(true)).toBe(true);

    expect(getWidgetMetricsEnabled()).toBe(true);
    expect(native.data.get("pw_widget_workspace")).toBeUndefined();
    expect(native.data.get("pw_widget_ready")).toBeUndefined();
  });

  it("commits a ready-marked snapshot stamped with the disclosure window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
    expect(setWidgetMetricsEnabled(true)).toBe(true);

    expect(writeWidgetSnapshot(healthyInput)).toBe(true);

    const updatedAt = native.data.get("pw_widget_updated_at") as number;
    const expiresAt = native.data.get("pw_widget_expires_at") as number;
    expect(native.data.get("pw_widget_schema")).toBe(1);
    expect(native.data.get("pw_widget_ready")).toBe(1);
    expect(expiresAt - updatedAt).toBe(WIDGET_SNAPSHOT_TTL_MS / 1000);
    expect(native.data.get("pw_widget_workspace")).toBe("Acme");
  });

  it("keeps the freshness window well inside the disclosure window", () => {
    // If these ever inverted, `staleness(at:)` on the Swift side would never
    // fire and a twelve-hour-old snapshot would be presented as current — the
    // exact dishonesty the split exists to prevent.
    expect(WIDGET_SNAPSHOT_FRESH_MS).toBeLessThan(WIDGET_SNAPSHOT_TTL_MS);
    expect(WIDGET_SNAPSHOT_FRESH_MS).toBeGreaterThan(0);
  });

  it("leaves the snapshot unreadable when a native write tears", () => {
    expect(setWidgetMetricsEnabled(true)).toBe(true);
    native.failSetKey = "pw_widget_pending";

    expect(writeWidgetSnapshot(healthyInput)).toBe(false);

    expect(native.data.get("pw_widget_ready")).toBe(0);
  });

  it("writes privacy tombstones and reports an incomplete physical purge", () => {
    expect(setWidgetMetricsEnabled(true)).toBe(true);
    expect(writeWidgetSnapshot(healthyInput)).toBe(true);
    native.failRemoveKey = "pw_widget_workspace";

    expect(clearWidgetSnapshot()).toBe(false);

    expect(native.data.get("pw_widget_metrics_opt_in_v1")).not.toBe(1);
    expect(native.data.get("pw_widget_ready")).not.toBe(1);
  });

  it("removes consent and every presence key during account teardown", () => {
    expect(setWidgetMetricsEnabled(true)).toBe(true);
    expect(writeWidgetSnapshot(healthyInput)).toBe(true);

    expect(clearWidgetSnapshot()).toBe(true);

    expect([...native.data.keys()]).toEqual([]);
    expect(getWidgetMetricsEnabled()).toBe(false);
  });

  it("makes strict account cleanup reject when App Group deletion is incomplete", async () => {
    expect(setWidgetMetricsEnabled(true)).toBe(true);
    expect(writeWidgetSnapshot(healthyInput)).toBe(true);
    native.failRemoveKey = "pw_widget_workspace";

    await expect(clearWidgetSnapshotStrict()).rejects.toThrow(
      "Widget App Group cleanup is incomplete",
    );
  });
});
