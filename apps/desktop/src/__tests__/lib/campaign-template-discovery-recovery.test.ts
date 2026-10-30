// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCampaignTemplateDiscoveryCreate,
  prepareCampaignTemplateDiscoveryCreate,
} from "../../lib/campaign-template-discovery-recovery";

const SCOPE = "0123456789abcdef";
const COLLECTION_STORAGE_KEY =
  "postwave.template-discovery-create.v1.0123456789abcdef.collection";

describe("campaign-template discovery create recovery", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("reuses the durable request key after a renderer remount or app restart", async () => {
    const keyFactory = vi
      .fn()
      .mockReturnValueOnce("01900000-0000-7000-8000-000000000001")
      .mockReturnValueOnce("01900000-0000-7000-8000-000000000002");
    const signature = JSON.stringify({
      name: "Launch inspiration",
      description: "",
      template_ids: [],
    });

    const first = await prepareCampaignTemplateDiscoveryCreate(
      SCOPE,
      "collection",
      signature,
      keyFactory,
    );
    // No in-memory value is passed to the second call. It represents a newly
    // mounted renderer recovering solely from the workspace-owned checkpoint.
    const afterRemount = await prepareCampaignTemplateDiscoveryCreate(
      SCOPE,
      "collection",
      signature,
      keyFactory,
    );

    expect(first).toMatchObject({
      ok: true,
      reused: false,
      attempt: { key: "01900000-0000-7000-8000-000000000001" },
    });
    expect(afterRemount).toMatchObject({
      ok: true,
      reused: true,
      attempt: { key: "01900000-0000-7000-8000-000000000001" },
    });
    expect(keyFactory).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(COLLECTION_STORAGE_KEY)).not.toContain(
      "Launch inspiration",
    );
  });

  it("retires the prior identity when input changes and isolates create kinds", async () => {
    const keyFactory = vi
      .fn()
      .mockReturnValueOnce("01900000-0000-7000-8000-000000000011")
      .mockReturnValueOnce("01900000-0000-7000-8000-000000000012")
      .mockReturnValueOnce("01900000-0000-7000-8000-000000000013");

    const first = await prepareCampaignTemplateDiscoveryCreate(
      SCOPE,
      "collection",
      '{"name":"First"}',
      keyFactory,
    );
    const changed = await prepareCampaignTemplateDiscoveryCreate(
      SCOPE,
      "collection",
      '{"name":"Second"}',
      keyFactory,
    );
    const savedSearch = await prepareCampaignTemplateDiscoveryCreate(
      SCOPE,
      "saved-search",
      '{"name":"Second","filters":{}}',
      keyFactory,
    );

    expect(first).toMatchObject({
      ok: true,
      attempt: { key: "01900000-0000-7000-8000-000000000011" },
    });
    expect(changed).toMatchObject({
      ok: true,
      reused: false,
      attempt: { key: "01900000-0000-7000-8000-000000000012" },
    });
    expect(savedSearch).toMatchObject({
      ok: true,
      reused: false,
      attempt: { key: "01900000-0000-7000-8000-000000000013" },
    });
  });

  it("fails closed without overwriting malformed uncertain state", async () => {
    const invalid = "x".repeat(1_025);
    window.localStorage.setItem(COLLECTION_STORAGE_KEY, invalid);
    const keyFactory = vi.fn(() => "new-key");

    const result = await prepareCampaignTemplateDiscoveryCreate(
      SCOPE,
      "collection",
      '{"name":"Could already exist"}',
      keyFactory,
    );

    expect(result).toEqual({
      ok: false,
      reason: "recovery-record-invalid",
    });
    expect(keyFactory).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(COLLECTION_STORAGE_KEY)).toBe(invalid);
  });

  it("clears confirmed outcomes and workspace-switch markers", async () => {
    await prepareCampaignTemplateDiscoveryCreate(
      SCOPE,
      "collection",
      '{"name":"Confirmed"}',
      () => "01900000-0000-7000-8000-000000000021",
    );

    expect(clearCampaignTemplateDiscoveryCreate(SCOPE, "collection")).toBe(
      true,
    );
    expect(window.localStorage.getItem(COLLECTION_STORAGE_KEY)).toBeNull();
  });
});
