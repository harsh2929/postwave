/**
 * The Voice hooks' request mapping and error handling, executed.
 *
 * TESTS-4. jest routes `@/hooks/useVoice` to the query-hook proxy, and no
 * vitest file imported it, so the save mapping ran on neither runner. The
 * dangerous regression is a quiet one: `PUT /api/v1/voice/brand-profile` is a
 * FULL REPLACE, so a save that sent `sample_snippets: []` would delete every
 * snippet an operator wrote on desktop while the phone reported "saved".
 *
 * `@/api/sdkClient` is mocked even though nothing here calls it: the real
 * `@/api/request` (kept for `statusFromError`) imports `./sdkClient`, which
 * reaches react-native, and the node environment cannot parse that. The read
 * key asserted after a save is read off the REAL `useBrandVoiceProfile()`
 * query, never retyped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type MutationOptions = {
  mutationFn: (input?: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, variables: unknown) => void;
};

type QueryOptions = {
  queryKey: readonly unknown[];
  enabled: boolean;
  queryFn: () => Promise<unknown>;
};

type SnapshotInput = {
  canUseNetwork: boolean;
  loadNetwork: () => Promise<unknown>;
  readSnapshot: () => Promise<unknown>;
  writeSnapshot: (value: unknown) => Promise<void>;
};

const m = vi.hoisted(() => ({
  gate: {
    enabled: true,
    baseUrl: "https://api.postwave.test",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    effectiveRole: "owner",
    credentialScope: "session",
    canReadOfflineSnapshots: true,
  },
  mutation: undefined as MutationOptions | undefined,
  query: undefined as QueryOptions | undefined,
  snapshot: undefined as SnapshotInput | undefined,
  invalidateQueries: vi.fn(),
  getBrandVoiceProfile: vi.fn(),
  putBrandVoiceProfile: vi.fn(),
  request: vi.fn(),
  vaultGetJSON: vi.fn(),
  vaultSetJSON: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: MutationOptions) => {
    m.mutation = options;
    return { isPending: false, mutate: vi.fn() };
  },
  useQuery: (options: QueryOptions) => {
    m.query = options;
    return options;
  },
  useQueryClient: () => ({ invalidateQueries: m.invalidateQueries }),
}));

vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => m.gate,
}));

vi.mock("@/api/brandVoice", () => ({
  getBrandVoiceProfile: m.getBrandVoiceProfile,
  putBrandVoiceProfile: m.putBrandVoiceProfile,
}));

vi.mock("@/api/client", () => ({
  getClient: () => ({ client: { request: m.request } }),
}));

vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({ client: { request: m.request } }),
}));

vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: () => true }));

vi.mock("@/lib/secureVault", () => ({
  vaultGetJSON: m.vaultGetJSON,
  vaultSetJSON: m.vaultSetJSON,
  vaultScopeForClient: () => "voice-vault-scope",
}));

vi.mock("@/lib/offlineSnapshots", () => ({
  loadOfflineCapableSnapshot: (input: SnapshotInput) => {
    m.snapshot = input;
    return Promise.resolve(undefined);
  },
}));

// eslint-disable-next-line import/first
import {
  useBrandVoiceProfile,
  useBuildVoiceProfile,
  useSaveBrandVoiceProfile,
  useVoiceProfile,
  voiceBuildErrorMessage,
} from "./useVoice";

function mutationOf(hook: () => unknown): MutationOptions {
  m.mutation = undefined;
  hook();
  // Re-read after the call: TS keeps the `undefined` narrowing across it.
  const registered = m.mutation as MutationOptions | undefined;
  if (!registered) throw new Error("the hook registered no mutation");
  return registered;
}

function queryOf(hook: () => unknown): QueryOptions {
  m.query = undefined;
  hook();
  const registered = m.query as QueryOptions | undefined;
  if (!registered) throw new Error("the hook registered no query");
  return registered;
}

/** The profile query's snapshot contract, as the hook hands it over. */
async function voiceSnapshotInput(): Promise<SnapshotInput> {
  m.snapshot = undefined;
  await queryOf(useVoiceProfile).queryFn();
  const loaded = m.snapshot as SnapshotInput | undefined;
  if (!loaded) throw new Error("the profile query loaded no snapshot");
  return loaded;
}

function sdkFailure(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

const DRAFT = {
  descriptors: ["warm", "plain-spoken"],
  writingRules: ["No exclamation marks."],
  sampleSnippets: ["keep me", "and me"],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.mutation = undefined;
  m.query = undefined;
  m.snapshot = undefined;
  m.gate.enabled = true;
});

describe("useSaveBrandVoiceProfile", () => {
  it("PUTs every array, snippets included, in the server's field names", async () => {
    m.putBrandVoiceProfile.mockResolvedValue({
      data: {
        id: "bv_1",
        descriptors: DRAFT.descriptors,
        writing_rules: DRAFT.writingRules,
        sample_snippets: DRAFT.sampleSnippets,
        updated_at: "2026-09-14T00:00:00Z",
      },
      error: null,
    });
    const options = mutationOf(useSaveBrandVoiceProfile);

    await expect(options.mutationFn(DRAFT)).resolves.toEqual({
      id: "bv_1",
      descriptors: ["warm", "plain-spoken"],
      writingRules: ["No exclamation marks."],
      sampleSnippets: ["keep me", "and me"],
      empty: false,
      updatedAt: "2026-09-14T00:00:00Z",
    });
    expect(m.putBrandVoiceProfile).toHaveBeenCalledTimes(1);
    expect(m.putBrandVoiceProfile).toHaveBeenCalledWith({
      descriptors: ["warm", "plain-spoken"],
      writing_rules: ["No exclamation marks."],
      sample_snippets: ["keep me", "and me"],
    });
  });

  it("REJECTS a refused save with the role sentence, never resolves it", async () => {
    m.putBrandVoiceProfile.mockResolvedValue({
      data: null,
      error: { status: 403, message: "forbidden" },
    });
    const options = mutationOf(useSaveBrandVoiceProfile);

    await expect(options.mutationFn(DRAFT)).rejects.toThrow(
      "Your role can't change the authored brand voice. Ask an admin.",
    );
  });

  it("refreshes exactly the authored-voice read after a save", () => {
    const options = mutationOf(useSaveBrandVoiceProfile);

    options.onSuccess?.(null, DRAFT);
    expect(m.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(m.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryOf(useBrandVoiceProfile).queryKey,
    });
  });
});

describe("useBrandVoiceProfile", () => {
  it("normalises the authored row the api module returns", async () => {
    m.getBrandVoiceProfile.mockResolvedValue({
      profile: {
        id: "bv_1",
        descriptors: ["warm"],
        writing_rules: [],
        sample_snippets: [],
      },
      notFound: false,
      error: null,
    });
    const options = queryOf(useBrandVoiceProfile);

    expect(options.enabled).toBe(true);
    await expect(options.queryFn()).resolves.toMatchObject({
      descriptors: ["warm"],
      writingRules: [],
      sampleSnippets: [],
      empty: false,
    });
  });

  it("fails a transport fault with its status, not as an empty profile", async () => {
    m.getBrandVoiceProfile.mockResolvedValue({
      profile: null,
      notFound: false,
      error: { status: 503, message: "upstream down" },
    });

    await expect(queryOf(useBrandVoiceProfile).queryFn()).rejects.toMatchObject(
      {
        message: "The brand-voice service is unavailable right now.",
        status: 503,
      },
    );
  });
});

describe("useVoiceProfile", () => {
  it("GETs the measured profile over the network", async () => {
    const profile = {
      generated_at: "2026-09-14T00:00:00Z",
      tonal: { humor: 0.2, optimism: 0.5, personal_vs_observational: 0.4, directness: 0.9 },
      persona: {},
    };
    m.request.mockResolvedValue(profile);
    const input = await voiceSnapshotInput();

    expect(input.canUseNetwork).toBe(true);
    await expect(input.loadNetwork()).resolves.toEqual({
      profile,
      fromSnapshot: false,
    });
    expect(m.request).toHaveBeenCalledWith("GET", "/api/v1/voice/profile");
  });

  it("reads a 404 as 'no profile yet' but surfaces every other failure", async () => {
    const input = await voiceSnapshotInput();

    m.request.mockRejectedValueOnce(sdkFailure(404, "not found"));
    await expect(input.loadNetwork()).resolves.toEqual({
      profile: null,
      fromSnapshot: false,
    });

    m.request.mockRejectedValueOnce(sdkFailure(500, "boom"));
    await expect(input.loadNetwork()).rejects.toThrow("boom");
  });

  it("never stores an absent profile or a copy that came from the vault", async () => {
    const input = await voiceSnapshotInput();

    await input.writeSnapshot({ profile: null, fromSnapshot: false });
    await input.writeSnapshot({
      profile: { generated_at: "2026-09-14T00:00:00Z" },
      fromSnapshot: true,
    });
    expect(m.vaultSetJSON).not.toHaveBeenCalled();

    await input.writeSnapshot({
      profile: { generated_at: "2026-09-14T00:00:00Z" },
      fromSnapshot: false,
    });
    expect(m.vaultSetJSON).toHaveBeenCalledWith(
      "voice",
      "profile",
      { generated_at: "2026-09-14T00:00:00Z" },
      { scope: "voice-vault-scope" },
    );
  });
});

describe("useBuildVoiceProfile", () => {
  it("POSTs the build route with an empty body", async () => {
    m.request.mockResolvedValue({ queued: true });

    await mutationOf(useBuildVoiceProfile).mutationFn();
    expect(m.request).toHaveBeenCalledWith(
      "POST",
      "/api/v1/voice/profile/build",
      {},
    );
  });

  it("names a 429 as the cooldown it is", () => {
    expect(voiceBuildErrorMessage(sdkFailure(429, "Too Many Requests"))).toBe(
      "Rebuild is rate-limited for this workspace. Wait a few minutes and try again.",
    );
    expect(voiceBuildErrorMessage(sdkFailure(500, "Server said no"))).toBe(
      "Server said no",
    );
  });
});
