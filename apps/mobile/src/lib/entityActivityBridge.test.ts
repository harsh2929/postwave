/**
 * The NSUserActivity donation bridge.
 *
 * Reachable from a node test because the module deliberately reads the Expo
 * global instead of importing `expo` — the same trick expo-router's own
 * ExpoHeadModule.js uses, and the reason store/authCleanup.ts can call the
 * purge without dragging a native chain into sign-out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The durable donation ledger. Mocked at the module boundary rather than
 * injected, because the bridge reaches AsyncStorage through a dynamic
 * `import()` precisely so that store/authCleanup.ts keeps a native-free
 * import graph.
 */
const ledger = vi.hoisted(() => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: vi.fn(async (key: string) => map.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      map.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      map.delete(key);
    }),
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: ledger,
}));

const LEDGER_KEY = "postwave.spotlight_donations.v1";
/** Let the fire-and-forget ledger write finish before asserting on it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// eslint-disable-next-line import/first
import type { EntityActivityDescriptor } from "./entityActivity";
// eslint-disable-next-line import/first
import {
  donateEntityActivity,
  purgeEntityActivities,
  resetTrackedEntityActivities,
  suspendEntityActivity,
  trackedEntityActivityIds,
} from "./entityActivityBridge";

/** The ambient `expo` global is typed by expo-modules-core; the bridge only
 * ever reads `.modules`, so tests install a minimal stand-in through unknown. */
type ExpoHost = { expo?: unknown };
const host = globalThis as unknown as ExpoHost;

function installHead(overrides: Record<string, unknown> = {}) {
  const head = {
    createActivity: vi.fn(),
    suspendActivity: vi.fn(),
    revokeActivity: vi.fn(),
    clearActivitiesAsync: vi.fn(async () => undefined),
    activities: { INDEXED_ROUTE: "com.moosewave.app.expo.index_route" },
    ...overrides,
  };
  host.expo = { modules: { ExpoHead: head } };
  return head;
}

function descriptor(
  overrides: Partial<EntityActivityDescriptor> = {},
): EntityActivityDescriptor {
  return {
    id: "postwave.entity.campaign.camp_1",
    title: "Summer Sale",
    description: "Sent to 12,400 people",
    webpageURL: "https://app.moosewave.com/app/campaigns/camp_1",
    href: "moosewave://campaign/camp_1",
    keywords: ["Summer Sale", "Moosewave"],
    isEligibleForHandoff: true,
    isEligibleForSearch: true,
    ...overrides,
  };
}

beforeEach(() => {
  resetTrackedEntityActivities();
  delete host.expo;
  ledger.map.clear();
  ledger.getItem.mockClear();
  ledger.setItem.mockClear();
  ledger.removeItem.mockClear();
});

afterEach(() => {
  delete host.expo;
});

describe("when no native module is present", () => {
  it("reports a donation as not made rather than pretending", () => {
    expect(donateEntityActivity(descriptor())).toBe(false);
    expect(trackedEntityActivityIds()).toEqual([]);
  });

  it("treats Expo Go as absent — the host app's modules are not ours", () => {
    host.expo = {
      modules: { ExpoGo: {}, ExpoHead: { createActivity: vi.fn() } },
    };
    expect(donateEntityActivity(descriptor())).toBe(false);
  });

  it("purges without throwing so sign-out cleanup still completes", async () => {
    await expect(purgeEntityActivities()).resolves.toBeUndefined();
    expect(() => suspendEntityActivity("anything")).not.toThrow();
  });
});

describe("donation", () => {
  it("never offers a workspace entity to Apple's public index or to Siri", () => {
    const head = installHead();
    expect(donateEntityActivity(descriptor())).toBe(true);

    const options = head.createActivity.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(options.isEligibleForPublicIndexing).toBe(false);
    expect(options.isEligibleForPrediction).toBe(false);
  });

  it("resumes through the app's own deep link, not a synthesised route", () => {
    const head = installHead();
    donateEntityActivity(descriptor());
    const options = head.createActivity.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(options.userInfo).toEqual({ href: "moosewave://campaign/camp_1" });
    expect(options.webpageURL).toBe(
      "https://app.moosewave.com/app/campaigns/camp_1",
    );
  });

  it("omits an absent description instead of sending an empty string", () => {
    const head = installHead();
    donateEntityActivity(descriptor({ description: null }));
    const options = head.createActivity.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect("description" in options).toBe(false);
  });

  it("survives a native throw without breaking the screen that donated", () => {
    installHead({
      createActivity: vi.fn(() => {
        throw new Error("native boom");
      }),
    });
    expect(donateEntityActivity(descriptor())).toBe(false);
    expect(trackedEntityActivityIds()).toEqual([]);
  });
});

describe("what the purge must be able to name", () => {
  it("tracks only the entities that were actually INDEXED", () => {
    // Handoff advertisements die with the process; only a search-index entry
    // needs deleting on sign-out, and tracking the rest would be noise.
    installHead();
    donateEntityActivity(descriptor());
    donateEntityActivity(
      descriptor({
        id: "postwave.entity.subscriber.sub_1",
        isEligibleForSearch: false,
      }),
    );
    expect(trackedEntityActivityIds()).toEqual([
      "postwave.entity.campaign.camp_1",
    ]);
  });

  it("deduplicates repeat opens of the same entity", () => {
    installHead();
    donateEntityActivity(descriptor());
    donateEntityActivity(descriptor());
    expect(trackedEntityActivityIds()).toHaveLength(1);
  });

  it("invalidates the live activity AND deletes the index entry", () => {
    const head = installHead();
    donateEntityActivity(descriptor());
    return purgeEntityActivities().then(() => {
      expect(head.revokeActivity).toHaveBeenCalledWith(
        "postwave.entity.campaign.camp_1",
      );
      expect(head.clearActivitiesAsync).toHaveBeenCalledWith([
        "postwave.entity.campaign.camp_1",
      ]);
      expect(trackedEntityActivityIds()).toEqual([]);
    });
  });

  it("REJECTS when the index delete fails, so cleanup reports incomplete", async () => {
    // clearLocalAuthArtifacts retries a rejected task and, failing twice,
    // names the area to the user. Swallowing this would claim a wipe that did
    // not happen.
    const head = installHead({
      clearActivitiesAsync: vi.fn(async () => {
        throw new Error("index unavailable");
      }),
    });
    donateEntityActivity(descriptor());
    await expect(purgeEntityActivities()).rejects.toThrow(/index unavailable/);
    expect(head.clearActivitiesAsync).toHaveBeenCalled();
    // Still tracked, so the retry deletes it rather than forgetting it.
    expect(trackedEntityActivityIds()).toEqual([
      "postwave.entity.campaign.camp_1",
    ]);
  });

  it("still deletes the index entry when invalidation throws", async () => {
    const head = installHead({
      revokeActivity: vi.fn(() => {
        throw new Error("already gone");
      }),
    });
    donateEntityActivity(descriptor());
    await expect(purgeEntityActivities()).resolves.toBeUndefined();
    expect(head.clearActivitiesAsync).toHaveBeenCalled();
  });
});

describe("donations made before this launch (SHELL#31 follow-up)", () => {
  it("records each donation where the NEXT process can read it", async () => {
    installHead();
    donateEntityActivity(descriptor());
    await settle();
    expect(JSON.parse(ledger.map.get(LEDGER_KEY) ?? "[]")).toEqual([
      "postwave.entity.campaign.camp_1",
    ]);
  });

  it("deletes what yesterday's process donated, not just this one's list", async () => {
    // The leak: sign out, hand the phone over, search Spotlight, read the
    // previous workspace's campaign titles. Nothing in this process donated
    // them, so an in-memory list had nothing to delete.
    ledger.map.set(
      LEDGER_KEY,
      JSON.stringify(["postwave.entity.campaign.camp_yesterday"]),
    );
    const head = installHead();

    await expect(purgeEntityActivities()).resolves.toBeUndefined();

    expect(head.clearActivitiesAsync).toHaveBeenCalledWith([
      "postwave.entity.campaign.camp_yesterday",
    ]);
    expect(head.revokeActivity).toHaveBeenCalledWith(
      "postwave.entity.campaign.camp_yesterday",
    );
    expect(ledger.map.has(LEDGER_KEY)).toBe(false);
  });

  it("purges this launch's and the previous launch's donations together", async () => {
    ledger.map.set(
      LEDGER_KEY,
      JSON.stringify(["postwave.entity.campaign.camp_yesterday"]),
    );
    const head = installHead();
    donateEntityActivity(descriptor());
    await settle();

    await purgeEntityActivities();

    const ids = (
      head.clearActivitiesAsync.mock.calls as unknown as [string[]][]
    )[0]?.[0];
    expect([...(ids ?? [])].sort()).toEqual([
      "postwave.entity.campaign.camp_1",
      "postwave.entity.campaign.camp_yesterday",
    ]);
  });

  it("REFUSES to report a complete wipe when the ledger cannot be read", async () => {
    // Reporting success here is the more serious half of the finding: the user
    // is told local cleanup finished while entries nobody can name are still
    // indexed. A rejection makes clearLocalAuthArtifacts name spotlight_index.
    installHead();
    ledger.getItem.mockImplementationOnce(async () => {
      throw new Error("storage unavailable");
    });
    await expect(purgeEntityActivities()).rejects.toThrow(/ledger unreadable/);
  });

  it("treats an unparseable ledger as unknown, not as empty", async () => {
    installHead();
    ledger.map.set(LEDGER_KEY, "{not-json");
    await expect(purgeEntityActivities()).rejects.toThrow(/ledger unreadable/);
  });

  it("keeps the ledger only until the platform confirms the delete", async () => {
    ledger.map.set(
      LEDGER_KEY,
      JSON.stringify(["postwave.entity.campaign.camp_yesterday"]),
    );
    installHead({
      clearActivitiesAsync: vi.fn(async () => {
        throw new Error("index unavailable");
      }),
    });
    await expect(purgeEntityActivities()).rejects.toThrow(/index unavailable/);
    // Still on record, so the retry names it instead of losing it.
    expect(ledger.map.has(LEDGER_KEY)).toBe(true);
  });

  it("costs no storage round-trip on a platform that cannot donate", async () => {
    // Android and Expo Go never index anything, so there is nothing to read.
    await expect(purgeEntityActivities()).resolves.toBeUndefined();
    expect(ledger.getItem).not.toHaveBeenCalled();
  });
});

describe("staying bounded without going blind", () => {
  function donateMany(count: number, from = 0): void {
    for (let i = from; i < from + count; i += 1) {
      donateEntityActivity(
        descriptor({ id: `postwave.entity.campaign.c${i}` }),
      );
    }
  }

  it("evicts the oldest by DELETING its index entry, not by forgetting it", async () => {
    // The old cap simply stopped remembering past 200, so entity 201 onward was
    // indexed by iOS and unnameable by the purge — a silent partial wipe.
    const head = installHead();
    donateMany(201);
    await settle();

    expect(head.clearActivitiesAsync).toHaveBeenCalledWith([
      "postwave.entity.campaign.c0",
    ]);
    const tracked = trackedEntityActivityIds();
    expect(tracked).toHaveLength(200);
    expect(tracked).not.toContain("postwave.entity.campaign.c0");
    expect(tracked).toContain("postwave.entity.campaign.c200");
  });

  it("keeps an over-cap id tracked when its eviction delete fails", async () => {
    installHead({
      clearActivitiesAsync: vi.fn(async () => {
        throw new Error("index busy");
      }),
    });
    donateMany(201);
    await settle();
    expect(trackedEntityActivityIds()).toContain("postwave.entity.campaign.c0");
  });
});
