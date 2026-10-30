/**
 * Boot-path latency guard for auth hydration.
 *
 * `hydrate()` is the one thing the launch gate waits on: `useHydrationGate`
 * will not let the app paint until `hydrated` is true (or the 8s watchdog
 * fires). Every serialized Keychain round trip inside it is time on the splash
 * screen, so the SHAPE of its storage I/O is a user-visible cost — and until
 * this file existed, nothing asserted that shape. `readStoredArtifacts`
 * batches seven reads through one `Promise.all`; a refactor to seven `await`s
 * would have been invisible to every other test in the tree while adding six
 * round trips to every cold start.
 *
 * WHAT A "WAVE" IS. expo-modules-core dispatches every AsyncFunction onto ONE
 * serial queue (`DispatchQueue(label: "expo.modules.AsyncFunctionQueue",
 * qos: .userInitiated)` — note the absence of `.concurrent`), so Keychain
 * calls never execute in parallel however JS issues them. What batching
 * removes is the ROUND TRIP: ops issued in a single JS turn drain
 * back-to-back natively and wake the JS thread once instead of once per op.
 * On a cold start that thread is also evaluating the module graph and running
 * React's first render, so each wake-up is a reschedule behind that work. A
 * wave below is one such round trip. Asserting waves rather than milliseconds
 * is deliberate: wall clock flakes, this does not.
 *
 * MEASURED 2026-09-03: 8 reads in 2 waves. Wave 1 is the vault
 * cleanup-journal probe alone; wave 2 is the seven auth artifacts.
 *
 * WHY WAVE 1 IS NOT MERGED INTO WAVE 2. It could be — the vault journal lives
 * under `postwave.mobile.vault.v3.*` and the auth artifacts under
 * `postwave.*`, disjoint namespaces with no read-after-write hazard, so
 * overlapping the READS while still awaiting the RECOVERY before any `set()`
 * would cost one round trip less. It is left sequential on purpose:
 * store/auth.test.ts asserts "recovers a vault purge before reading or
 * restoring an identity", checking `recovered === true` inside every
 * `getItemAsync`. That is a deliberate crash-recovery ordering, and one round
 * trip is not a reason to relax it without the owner's call. This test pins
 * the current shape so the trade stays visible if anyone revisits it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  store: new Map<string, string>(),
  ops: [] as { key: string; wave: number }[],
  inflight: 0,
  waves: 0,
  recording: false,
}));

/**
 * Every mocked storage call takes a real (tiny) timer, so "issued in the same
 * JS turn" is unambiguous: concurrent issues share a wave, a sequential
 * `await` cannot.
 */
function op<T>(key: string, run: () => T): Promise<T> {
  if (!probe.recording) return Promise.resolve(run());
  if (probe.inflight === 0) probe.waves += 1;
  probe.inflight += 1;
  probe.ops.push({ key, wave: probe.waves });
  return new Promise<T>((resolve) => {
    setTimeout(() => {
      probe.inflight -= 1;
      resolve(run());
    }, 1);
  });
}

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItem: vi.fn(() => null),
  getItemAsync: vi.fn((key: string) =>
    op(key, () => probe.store.get(key) ?? null),
  ),
  setItemAsync: vi.fn((key: string, value: string) =>
    op(key, () => {
      probe.store.set(key, value);
    }),
  ),
  deleteItemAsync: vi.fn((key: string) =>
    op(key, () => {
      probe.store.delete(key);
    }),
  ),
}));

// Everything the store reaches that is not storage. lib/secureVault is
// deliberately NOT mocked — its cleanup-journal probe is one of the ops being
// counted, and mocking it away would hide a round trip the app really pays.
vi.mock("@/api/sdkClient", () => ({ clearClient: vi.fn() }));
vi.mock("@/api/auth", () => ({
  createAuthClient: vi.fn((baseUrl: string) => ({ baseUrl })),
  setMfaRequiredObserver: vi.fn(),
}));
vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: vi.fn(() => false) }));
vi.mock("@/lib/magicLinkState", () => ({ clearPendingAuthLinkStates: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { clear: vi.fn() },
  queryPersister: { removeClient: vi.fn() },
}));
vi.mock("@/lib/sharedInbox", () => ({
  clearSharedInbox: vi.fn(),
  clearSharedInboxStrict: vi.fn(),
}));
vi.mock("@/lib/telemetry", () => ({ track: vi.fn(), reset: vi.fn() }));
vi.mock("@/lib/widgetData", () => ({
  clearWidgetSnapshot: vi.fn(),
  clearWidgetSnapshotStrict: vi.fn(),
}));

// eslint-disable-next-line import/first
import { useAuthStore } from "./auth";

const VAULT_CLEANUP_KEY = "postwave.mobile.vault.v3.__cleanup_pending";

const AUTH_ARTIFACT_KEYS = [
  "postwave.api_key",
  "postwave.base_url",
  "postwave.tenant_id",
  "postwave.session_profile",
  "postwave.session_profile.pending",
  "postwave.auth_cleanup_pending",
  "postwave.session_revocation_pending",
] as const;

async function recordHydrate() {
  probe.ops.length = 0;
  probe.inflight = 0;
  probe.waves = 0;
  probe.recording = true;
  await useAuthStore.getState().hydrate();
  probe.recording = false;
  return {
    ops: probe.ops.map((entry) => entry.key),
    waves: probe.waves,
    waveOf: (key: string) => probe.ops.find((e) => e.key === key)?.wave,
  };
}

describe("hydrate() boot-path I/O shape", () => {
  beforeEach(() => {
    probe.store.clear();
    probe.recording = false;
    useAuthStore.setState({ hydrated: false });
  });

  it("reads all seven auth artifacts in ONE round trip", async () => {
    const run = await recordHydrate();

    // The op COUNT is asserted too: a new key on the launch read is a real
    // cost and should have to be added here deliberately.
    expect(run.ops).toHaveLength(8);
    const artifactWaves = new Set(
      AUTH_ARTIFACT_KEYS.map((key) => run.waveOf(key)),
    );
    expect(artifactWaves.size).toBe(1);
    expect([...artifactWaves][0]).toBeDefined();
  });

  it("costs exactly two round trips end to end", async () => {
    const run = await recordHydrate();

    // Wave 1: the vault cleanup-journal probe. Wave 2: the artifact batch.
    // Nothing else may join the launch path without showing up here.
    expect(run.waves).toBe(2);
    expect(run.waveOf(VAULT_CLEANUP_KEY)).toBe(1);
    expect(run.waveOf("postwave.session_profile")).toBe(2);
  });

  it("never un-hydrates, so the launch watchdog is armed at most once", async () => {
    // What bounds the splash is `useHydrationGate`'s single 8s timer, and that
    // timer is armed by an effect keyed on `settled = hydrated && fontsSettled`.
    // Both inputs are monotonic today, so the effect runs once and the bound
    // holds. If a teardown path ever set `hydrated` back to false mid-session,
    // `proceed` would flip back to false — the shell would UN-PAINT and re-arm
    // an 8s watchdog over a working app. Cheaper to pin than to debug.
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().hydrated).toBe(true);

    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().hydrated).toBe(true);

    await useAuthStore.getState().cancelSession();
    expect(useAuthStore.getState().hydrated).toBe(true);
  });

  it("still finishes the vault purge BEFORE committing a restored identity", async () => {
    // The ordering the round-trip count is paying for. A pending purge journal
    // belongs to the PREVIOUS identity; a corrupt manifest makes recovery
    // throw, and hydrate must then fail CLOSED rather than restore anything.
    probe.store.set(VAULT_CLEANUP_KEY, "1");
    probe.store.set("postwave.mobile.vault.v3.__manifest", "not json");
    // Credentials that WOULD restore an api_key identity if the vault branch
    // were skipped — so this asserts the veto, not merely an empty device.
    probe.store.set("postwave.api_key", "pk_live_xxx");
    probe.store.set("postwave.base_url", "https://api.moosewave.com");
    probe.store.set("postwave.tenant_id", "tenant-1");

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().mode).toBeNull();
    expect(useAuthStore.getState().apiKey).toBeNull();
    // ...and the local artifacts were wiped, not just ignored in memory.
    expect(probe.store.has("postwave.api_key")).toBe(false);
  });
});
