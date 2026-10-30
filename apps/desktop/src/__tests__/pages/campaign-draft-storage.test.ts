import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { desktopRouteIdentityScope } from "../../lib/desktop-router";
import { vaultSetJSON } from "../../lib/secure-vault";
import {
  campaignDraftJournalKey,
  purgeAmbiguousCampaignDraft,
  readCampaignDraft,
  sanitizeCampaignDraft,
  writeCampaignDraft,
} from "../../pages/campaigns/campaign-draft-storage";

const ALPHA = desktopRouteIdentityScope("alpha-user", "alpha-tenant")!;
const BETA = desktopRouteIdentityScope("beta-user", "beta-tenant")!;
const draft = {
  body: "<p>Alpha private body</p>",
  fromEmail: "alpha@example.com",
  name: "Alpha launch",
  previewText: "A private preview",
  subject: "Private subject",
};
const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    },
    crypto: globalThis.crypto,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("campaign draft recovery storage", () => {
  it("encrypts and isolates a bounded draft by user and workspace", async () => {
    await writeCampaignDraft(ALPHA, draft);

    await expect(readCampaignDraft(ALPHA)).resolves.toEqual({
      status: "ready",
      draft,
    });
    await expect(readCampaignDraft(BETA)).resolves.toEqual({
      status: "missing",
    });
    const atRest = [...storage.entries()].flat().join("\n");
    expect(atRest).not.toContain("alpha@example.com");
    expect(atRest).not.toContain("Alpha private body");
  });

  it("deletes the ownership-ambiguous v1 draft without adopting it", async () => {
    await vaultSetJSON("lifecycle-draft:campaign-create:v1", draft);
    expect(storage.size).toBe(1);

    purgeAmbiguousCampaignDraft();

    expect(storage.size).toBe(0);
    await expect(readCampaignDraft(ALPHA)).resolves.toEqual({
      status: "missing",
    });
  });

  it("rejects malformed, oversized, and identity-free records", async () => {
    expect(
      sanitizeCampaignDraft({ ...draft, previewText: "x".repeat(201) }),
    ).toBeNull();
    await expect(
      writeCampaignDraft(ALPHA, { ...draft, body: "x".repeat(501 * 1024) }),
    ).rejects.toThrow(/large|invalid/i);
    await expect(writeCampaignDraft(null, draft)).rejects.toThrow(/identity/i);
    expect(campaignDraftJournalKey(null)).toBeNull();

    const key = campaignDraftJournalKey(ALPHA)!;
    await vaultSetJSON(key, { ...draft, fromEmail: 42 });
    await expect(readCampaignDraft(ALPHA)).resolves.toEqual({
      status: "invalid",
    });
    expect(storage.size).toBe(0);
  });
});
